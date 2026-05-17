import { Buffer } from "node:buffer";
import JSZip from "jszip";
import { METADATA_CATEGORY } from "../../../domain/index.js";
import type { RawMember } from "../../interfaces/metadata-source.js";
import { withTimeout } from "../rate-limit.js";

/**
 * OmniStudio-on-Core retrieval via Metadata API `retrieve()` rather than
 * SOQL on the standard SObjects. SOQL gives you `OmniProcess.PropertySet`
 * and `OmniProcessElement.PropertySet` as JSON blobs — useful, but the
 * platform omits design-time XML constructs that only the Metadata API
 * envelope carries (conditional branches inside IPs, layout config on
 * UI cards, embedded server-script references on DataTransforms).
 *
 * This extractor runs **alongside** the SOQL path rather than replacing
 * it: SOQL has lower latency for "what processes exist + their element
 * graph"; retrieve() has higher fidelity for "what does this process
 * actually do." Parsers can choose which input to consume per use case.
 *
 * Constraints, all from W2-02's research:
 * - Metadata API has a documented org-wide quota of 10,000 retrieve
 *   calls per 24h. We track the response's `Sforce-Limit-Info` header
 *   when available and bail out at 90% utilisation rather than blow
 *   the budget on a single ingest.
 * - retrieve() is async — call returns a locator with an async process
 *   ID; we poll via `checkRetrieveStatus`. jsforce's
 *   `RetrieveResultLocator.complete()` wraps the polling loop.
 * - `package.xml` can list up to 5,000 components per call. Our types
 *   are wildcards (`<members>*</members>`), which DOES count against
 *   the cap if the org has 5k+ of any one type — chunk by listing
 *   first and slicing.
 *
 * Capability-gated by `caps.omnistudioOncore`; the caller (bulk-retrieve)
 * additionally gates on the opt-in `enableOmnistudioRetrieve` flag from
 * LiveIngestOpts.
 */

/** OmniStudio-on-Core Metadata API type names. These differ from the
 *  Vlocity DataPack type vocabulary — the cross-flavor resolver and
 *  overlap detector understand both. */
const RETRIEVE_TYPES = ["OmniUiCard", "OmniIntegrationProcedure", "OmniDataTransform"] as const;

/** Polling cadence for `retrieve()` job status. Salesforce typically
 *  finishes within 5-15s for small types; aggressive polling burns
 *  rate-limit headroom for no value. */
const POLL_INTERVAL_MS = 3_000;
/** Hard ceiling on per-retrieve wall time. Large orgs (5k+ components
 *  of a single type) legitimately take 60-90s; the bisection / quota
 *  guard handles the catastrophic case. */
const RETRIEVE_TIMEOUT_MS = 180_000;
/** Conservative quota utilisation threshold. When usage exceeds this
 *  fraction of the daily 10k limit, skip remaining retrieves and
 *  surface a warning. Leaves headroom for downstream operations. */
const QUOTA_SKIP_THRESHOLD = 0.9;

export interface OmnistudioRetrieveOpts {
  /** Org API version, e.g. "60.0". Used in retrieve request envelope. */
  apiVersion: string;
  /** Called on per-type or per-zip failure. Mirrors the W1-01 onError
   *  contract used by the Vlocity runner. */
  onError?: (label: string, err: Error) => void;
}

interface SfLimitInfo {
  current: number;
  limit: number;
}

/** Parse the `Sforce-Limit-Info` header which Salesforce attaches to most
 *  REST/SOAP responses: `api-usage=12345/15000`. Returns null if absent
 *  or malformed — caller assumes "enough quota" in that case rather
 *  than refusing to proceed. */
function parseLimitInfo(header: string | undefined): SfLimitInfo | null {
  if (!header) return null;
  const m = header.match(/api-usage=(\d+)\/(\d+)/);
  if (!m) return null;
  const current = Number.parseInt(m[1] ?? "", 10);
  const limit = Number.parseInt(m[2] ?? "", 10);
  if (!Number.isFinite(current) || !Number.isFinite(limit) || limit <= 0) return null;
  return { current, limit };
}

/** Decide whether to skip a retrieve based on current quota utilisation.
 *  Conservative: when in doubt (no limit info available) we proceed. */
export function shouldSkipForQuota(limit: SfLimitInfo | null): boolean {
  if (!limit) return false;
  return limit.current / limit.limit >= QUOTA_SKIP_THRESHOLD;
}

interface RetrieveResultLite {
  zipFile?: string;
  status?: string;
  done?: boolean;
  errorMessage?: string;
}

/** Yield one RawMember per file extracted from the retrieve zip. The
 *  `category` is set to OMNI_PROCESS uniformly — the parser layer
 *  discriminates on the file path / XML root element. */
async function* yieldFromZip(
  zipBase64: string,
  orgId: string,
  type: string,
): AsyncIterable<RawMember> {
  const buf = Buffer.from(zipBase64, "base64");
  const zip = await JSZip.loadAsync(buf);
  for (const [path, file] of Object.entries(zip.files)) {
    if (file.dir) continue;
    // Skip the manifest file — it's metadata about the retrieve, not a
    // component definition. Path looks like `unpackaged/package.xml`.
    if (path.endsWith("/package.xml") || path === "package.xml") continue;
    // Each file is `unpackaged/<typeFolder>/<name>.<ext>`. The parsed
    // name is just the file basename without extension.
    const segments = path.split("/");
    const filename = segments[segments.length - 1] ?? path;
    const memberName = filename.replace(/\.[^.]+$/, "");
    const content = await file.async("string");
    yield {
      ref: {
        category: METADATA_CATEGORY.OMNI_PROCESS,
        memberType: type,
        memberName,
        lastModifiedAt: "",
        sourceUri: `sf://${orgId}/${type}/${memberName}.xml`,
        namespace: null,
      },
      content,
    };
  }
}

/**
 * Async iterator yielding XML envelopes for OmniStudio-on-Core types via
 * Metadata API `retrieve()`. Falls back silently (yields nothing) on
 * orgs without the capability or when quota would be exhausted.
 */
export async function* iterOmnistudioRetrieve(
  conn: any,
  orgId: string,
  opts: OmnistudioRetrieveOpts,
): AsyncIterable<RawMember> {
  // Check quota up-front (single call to limits endpoint via REST). If the
  // helper isn't available we proceed and let per-call failures surface.
  let limit: SfLimitInfo | null = null;
  try {
    const limitInfo = (conn as { _sforceLimitInfo?: string })._sforceLimitInfo;
    limit = parseLimitInfo(limitInfo);
  } catch {
    // jsforce holds the most-recent limit header on the conn after any
    // call; if no calls have happened yet, we have no signal and proceed.
  }
  if (shouldSkipForQuota(limit)) {
    opts.onError?.(
      "omnistudio-retrieve:quota-guard",
      new Error(
        `metadata API quota at ${limit?.current}/${limit?.limit} (>=${QUOTA_SKIP_THRESHOLD * 100}%) — skipping retrieve()`,
      ),
    );
    return;
  }

  for (const type of RETRIEVE_TYPES) {
    const label = `omnistudio-retrieve:${type}`;
    try {
      const request = {
        apiVersion: opts.apiVersion,
        unpackaged: {
          types: [{ name: type, members: ["*"] }],
          version: opts.apiVersion,
        },
      };
      const locator = conn.metadata.retrieve(request);
      const result = (await withTimeout(
        locator.complete({ details: false }),
        RETRIEVE_TIMEOUT_MS,
        label,
      )) as RetrieveResultLite;
      if (result.status && result.status !== "Succeeded") {
        opts.onError?.(label, new Error(`retrieve() status=${result.status} ${result.errorMessage ?? ""}`));
        continue;
      }
      if (!result.zipFile) {
        opts.onError?.(label, new Error("retrieve() returned no zipFile"));
        continue;
      }
      for await (const member of yieldFromZip(result.zipFile, orgId, type)) {
        yield member;
      }
      // Re-check quota between types — a single retrieve can return
      // thousands of components and shift utilisation significantly.
      const nextLimit = (() => {
        try {
          return parseLimitInfo((conn as { _sforceLimitInfo?: string })._sforceLimitInfo);
        } catch {
          return null;
        }
      })();
      if (shouldSkipForQuota(nextLimit)) {
        opts.onError?.(
          "omnistudio-retrieve:quota-guard",
          new Error(
            `metadata API quota crossed ${QUOTA_SKIP_THRESHOLD * 100}% after ${type} — skipping remaining types`,
          ),
        );
        return;
      }
    } catch (e) {
      opts.onError?.(label, e as Error);
      // continue to next type — one type failing (e.g. permission gap on
      // OmniUiCard) shouldn't disable retrieval of the other two.
    }
  }
}
