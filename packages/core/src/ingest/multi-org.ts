import type { Logger } from "@ryanstark24/sfgraph-shared";
import type { LiveIngestOpts, LiveIngestResult } from "./live-ingest.js";
import { liveIngest } from "./live-ingest.js";

export interface MultiOrgIngestOpts {
  aliases: string[];
  parallel?: boolean;
  /** Factory called per alias to build the per-org ingest options. */
  buildOpts: (alias: string) => Promise<LiveIngestOpts> | LiveIngestOpts;
  /** Optional override for the underlying ingest function (tests inject here). */
  runOne?: (opts: LiveIngestOpts) => Promise<LiveIngestResult>;
  logger?: Logger;
}

export interface MultiOrgIngestEntry {
  alias: string;
  status: "ok" | "error";
  result?: LiveIngestResult;
  error?: string;
  startedAt: number;
  finishedAt: number;
}

export interface MultiOrgIngestSummary {
  parallel: boolean;
  entries: MultiOrgIngestEntry[];
  totalElapsedMs: number;
}

/**
 * Run `liveIngest` for a list of aliases. Sequential by default; pass
 * `parallel: true` to fan out via `Promise.allSettled` so one alias's failure
 * does not abort the others.
 *
 * NOTE: All parallel orgs currently share the process-wide default rate-limit
 * pools. Bottleneck handles concurrent schedule() calls safely; per-org
 * dedicated pools can be wired through `LiveIngestOpts.pools` in a future
 * iteration without breaking this orchestrator's public surface.
 */
export async function multiOrgIngest(opts: MultiOrgIngestOpts): Promise<MultiOrgIngestSummary> {
  const runOne = opts.runOne ?? liveIngest;
  const parallel = Boolean(opts.parallel);
  const startedAtAll = Date.now();
  const entries: MultiOrgIngestEntry[] = [];

  const runFor = async (alias: string): Promise<MultiOrgIngestEntry> => {
    const startedAt = Date.now();
    try {
      const built = await opts.buildOpts(alias);
      const result = await runOne(built);
      return {
        alias,
        status: "ok",
        result,
        startedAt,
        finishedAt: Date.now(),
      };
    } catch (e) {
      return {
        alias,
        status: "error",
        error: (e as Error).message ?? String(e),
        startedAt,
        finishedAt: Date.now(),
      };
    }
  };

  if (parallel) {
    const settled = await Promise.allSettled(opts.aliases.map((a) => runFor(a)));
    for (const s of settled) {
      if (s.status === "fulfilled") entries.push(s.value);
      // Rejections shouldn't happen because runFor catches; defensive fallback:
      else
        entries.push({
          alias: "<unknown>",
          status: "error",
          error: String(s.reason),
          startedAt: startedAtAll,
          finishedAt: Date.now(),
        });
    }
  } else {
    for (const alias of opts.aliases) {
      const entry = await runFor(alias);
      entries.push(entry);
      const suffix = entry.result
        ? ` members=${entry.result.membersProcessed} deletions=${entry.result.deletions} parseErrors=${entry.result.parseErrors}`
        : entry.error
          ? ` error=${entry.error}`
          : "";
      opts.logger?.info(
        `ingest[${alias}]: ${entry.status} elapsed=${entry.finishedAt - entry.startedAt}ms${suffix}`,
      );
    }
  }

  return {
    parallel,
    entries,
    totalElapsedMs: Date.now() - startedAtAll,
  };
}

/**
 * List every authenticated org alias using `@salesforce/core` AuthInfo.
 * Returns alias (preferred) or username when no alias exists.
 */
export async function listAllAuthenticatedOrgs(deps: { AuthInfo?: any } = {}): Promise<string[]> {
  let AuthInfo: any = deps.AuthInfo;
  if (!AuthInfo) {
    const sfCore = await import("@salesforce/core");
    AuthInfo = sfCore.AuthInfo;
  }
  const auths = (await AuthInfo.listAllAuthorizations()) as Array<{
    alias?: string;
    aliases?: string[];
    username?: string;
  }>;
  const out: string[] = [];
  for (const a of auths) {
    const alias = a.aliases?.[0] ?? a.alias ?? a.username;
    if (alias) out.push(alias);
  }
  return out;
}
