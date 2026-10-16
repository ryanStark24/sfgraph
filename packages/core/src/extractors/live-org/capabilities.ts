import { isOrgRejection, withRetry } from "./retry.js";

export const VLOCITY_NAMESPACE_CANDIDATES = [
  "vlocity_cmt",
  "vlocity_ins",
  "vlocity_hc",
  "vlocity_ps",
  "vlocity_fs",
  // OmniStudio managed package was forked from Vlocity-CMT and ships an
  // identical SObject schema under the `omnistudio` namespace. Detecting
  // it via the same DRBundle__c probe lets the vlocity extractor pull
  // OmniScripts / Integration Procedures / DataRaptors from
  // OmniStudio-managed orgs without writing a parallel extractor.
  "omnistudio",
] as const;

export type VlocityNamespace = (typeof VLOCITY_NAMESPACE_CANDIDATES)[number];

/**
 * A capability probe that failed for a reason other than "the object is not
 * in this org" (timeout, connection reset, 5xx) even after retries. The
 * capability is reported as false, but `source` names the bulk-retrieve
 * source it gates so the run records a skip instead of silently dropping
 * that source (review I2). `source` is null when the probe gates no source.
 */
export interface CapabilityProbeError {
  probe: string;
  source: "vlocity" | "omnistudio" | null;
  error: string;
}

export interface OrgCapabilities {
  detectedNamespaces: string[];
  /** Subset of VLOCITY_NAMESPACE_CANDIDATES whose `${ns}__DRBundle__c` exists. */
  vlocityNamespaces: string[];
  /** True if any Vlocity industry namespace was detected. */
  vlocityLegacy: boolean;
  /** Back-compat alias: equivalent to vlocityNamespaces.includes('vlocity_cmt'). */
  vlocityCmt: boolean;
  omnistudioOncore: boolean;
  agentforce: boolean;
  experienceCloud: boolean;
  sourceTracking: boolean;
  /** Probes that failed transiently (see {@link CapabilityProbeError}).
   *  Absent / empty when every probe gave a definite answer. */
  probeErrors?: CapabilityProbeError[];
}

// All capability probes use a SHORT 15s timeout — they're tiny single-row
// queries against well-known SObjects, and probeCapabilities is the very
// first thing every ingest does. If the connection's dead at this stage,
// we want to surface that within seconds, not hang the whole startup
// hoping for a response that's never coming.
const CAPS_PROBE_TIMEOUT_MS = 15_000;
async function withCapsTimeout<T>(p: Promise<T>, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(
      () => reject(new Error(`capabilities probe ${label} timeout (${CAPS_PROBE_TIMEOUT_MS}ms)`)),
      CAPS_PROBE_TIMEOUT_MS,
    );
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });
}

async function safeQuery(conn: any, soql: string): Promise<{ records?: unknown[] } | null> {
  try {
    return (await withCapsTimeout(conn.query(soql), `query ${soql.slice(0, 40)}`)) as {
      records?: unknown[];
    };
  } catch {
    return null;
  }
}

async function safeToolingQuery(conn: any, soql: string): Promise<{ records?: unknown[] } | null> {
  try {
    return (await withCapsTimeout(conn.tooling.query(soql), `tooling ${soql.slice(0, 40)}`)) as {
      records?: unknown[];
    };
  } catch {
    return null;
  }
}

/** The describe failed because the object is not in this org (or the user
 *  cannot see it) — a definite "no", not a transient failure. */
function isAbsent(e: unknown): boolean {
  if (isOrgRejection(e)) return true;
  const msg =
    e instanceof Error
      ? `${(e as { errorCode?: string }).errorCode ?? ""} ${e.message}`
      : String(e);
  return /NOT_FOUND|does not exist|no such/i.test(msg);
}

/** Retries for a transient describe failure (backoff per retry.ts). */
const PROBE_RETRIES = 2;

/**
 * Probe whether `name` is describable. Absence → false. Any other failure
 * (timeout, reset, 5xx) is retried; if it still fails the probe is recorded
 * in `errors` (and reported false). Previously every error mapped to false,
 * so a probe timeout silently removed the whole vlocity / omnistudio source.
 */
async function describeExists(
  conn: any,
  name: string,
  useTooling: boolean,
  source: CapabilityProbeError["source"],
  errors: CapabilityProbeError[],
): Promise<boolean> {
  const root = useTooling ? conn.tooling : conn;
  try {
    await withRetry(
      async () => {
        try {
          await withCapsTimeout(root.sobject(name).describe(), `describe ${name}`);
        } catch (e) {
          // Absence is an answer, not a failure: stop retrying.
          if (isAbsent(e)) throw new AbsentError();
          throw e;
        }
      },
      { retries: PROBE_RETRIES },
    );
    return true;
  } catch (e) {
    if (e instanceof AbsentError) return false;
    errors.push({ probe: name, source, error: e instanceof Error ? e.message : String(e) });
    return false;
  }
}

/** Internal marker: the probed object does not exist. Classified as an org
 *  rejection (INVALID_TYPE in the message) so withRetry does not retry it. */
class AbsentError extends Error {
  constructor() {
    super("INVALID_TYPE: probed object absent");
    this.name = "AbsentError";
  }
}

/** Probe a Salesforce org for installed packages, features, and source-tracking support. */
export async function probeCapabilities(conn: any): Promise<OrgCapabilities> {
  // Organization metadata
  await safeQuery(conn, "SELECT Id, OrganizationType, IsSandbox FROM Organization LIMIT 1");

  // Installed-package namespaces via tooling
  const namespaces: string[] = [];
  const pkgs = await safeToolingQuery(conn, "SELECT NamespacePrefix FROM PackageLicense");
  if (pkgs?.records) {
    for (const r of pkgs.records as Array<{ NamespacePrefix?: string }>) {
      if (r.NamespacePrefix) namespaces.push(r.NamespacePrefix);
    }
  }

  const probeErrors: CapabilityProbeError[] = [];
  const vlocityProbes = await Promise.all(
    VLOCITY_NAMESPACE_CANDIDATES.map((ns) =>
      describeExists(conn, `${ns}__DRBundle__c`, false, "vlocity", probeErrors),
    ),
  );
  const vlocityNamespaces: string[] = VLOCITY_NAMESPACE_CANDIDATES.filter(
    (_ns, i) => vlocityProbes[i],
  );

  const [omnistudioOncore, agentforce, experienceCloud, sourceTracking] = await Promise.all([
    describeExists(conn, "OmniProcess", false, "omnistudio", probeErrors),
    // These gate no bulk-retrieve source (sourceTracking only picks
    // incremental vs full; false → full, the safe direction), but their
    // failures are still reported.
    describeExists(conn, "GenAiPlanner", true, null, probeErrors),
    describeExists(conn, "Network", false, null, probeErrors),
    describeExists(conn, "SourceMember", true, null, probeErrors),
  ]);

  return {
    detectedNamespaces: namespaces,
    vlocityNamespaces,
    vlocityLegacy: vlocityNamespaces.length > 0,
    vlocityCmt: vlocityNamespaces.includes("vlocity_cmt"),
    omnistudioOncore,
    agentforce,
    experienceCloud,
    sourceTracking,
    ...(probeErrors.length > 0 ? { probeErrors } : {}),
  };
}
