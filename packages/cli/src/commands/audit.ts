import path from "node:path";
import {
  SqliteGraphStore,
  auditDanglingEdges,
  deleteDanglingEdges,
  resolveDefaultOrgAlias,
  resolveOrg,
} from "@ryanstark24/sfgraph-core";
import {
  ConfigError,
  SfgraphError,
  asOrgId,
  findProjectRoot,
  getSfgraphPaths,
  readWorkspace,
  safeOrgDbPath,
} from "@ryanstark24/sfgraph-shared";

export interface AuditOpts {
  org?: string | undefined;
  project?: string | undefined;
  format?: "table" | "json" | undefined;
  sample?: number | undefined;
  /** When set, dangling edges are deleted (requires --yes). */
  deleteDangling?: boolean | undefined;
  yes?: boolean | undefined;
}

async function resolveOrgIdFromOpts(opts: AuditOpts): Promise<string> {
  if (opts.org) {
    const r = await resolveOrg(opts.org);
    return String(r.orgId);
  }
  const startDir = opts.project ? path.resolve(opts.project) : process.cwd();
  const projectRoot = findProjectRoot(startDir) ?? startDir;
  const ws = await readWorkspace(projectRoot);
  if (ws?.orgId) return String(ws.orgId);
  const alias = await resolveDefaultOrgAlias();
  if (!alias) {
    throw new ConfigError(
      "audit: no --org provided, no workspace binding, and no default org configured.",
    );
  }
  const r = await resolveOrg(alias);
  return String(r.orgId);
}

function pad(s: string, n: number): string {
  return s.length >= n ? s : s + " ".repeat(n - s.length);
}

function printTable(
  orgId: string,
  totalEdges: number,
  danglingCount: number,
  byRel: Record<string, number>,
  byDstPrefix: Record<string, number>,
  sample: Array<{ src: string; rel: string; dst: string }>,
): void {
  const pct = totalEdges === 0 ? "0%" : `${((danglingCount / totalEdges) * 100).toFixed(1)}%`;
  console.log(`audit: org=${orgId}`);
  console.log(`  total edges:   ${totalEdges}`);
  console.log(`  dangling:      ${danglingCount}  (${pct})`);
  if (danglingCount === 0) return;
  console.log("");
  console.log("  by relType:");
  for (const [k, v] of Object.entries(byRel).sort((a, b) => b[1] - a[1])) {
    console.log(`    ${pad(k, 32)} ${v}`);
  }
  console.log("");
  console.log("  by dst-prefix:");
  for (const [k, v] of Object.entries(byDstPrefix).sort((a, b) => b[1] - a[1])) {
    console.log(`    ${pad(k, 32)} ${v}`);
  }
  if (sample.length > 0) {
    console.log("");
    console.log(`  sample (${sample.length}):`);
    for (const s of sample) {
      console.log(`    ${s.src}  --${s.rel}-->  ${s.dst}`);
    }
  }
}

export async function auditCmd(opts: AuditOpts): Promise<void> {
  try {
    const orgId = await resolveOrgIdFromOpts(opts);
    const dbPath = safeOrgDbPath(getSfgraphPaths().data, orgId);
    const store = new SqliteGraphStore({ dbPath });
    await store.init();

    try {
      const sampleSize = opts.sample ?? 25;
      const result = auditDanglingEdges(store, orgId, { sampleSize });

      if (opts.format === "json") {
        console.log(JSON.stringify({ orgId, ...result }, null, 2));
      } else {
        printTable(
          orgId,
          result.totalEdges,
          result.danglingCount,
          result.byRel,
          result.byDstPrefix,
          result.sample,
        );
      }

      if (opts.deleteDangling) {
        if (!opts.yes) {
          console.error(
            "audit: --delete-dangling refused without --yes (destructive operation).",
          );
          process.exitCode = 1;
          return;
        }
        const { deleted } = deleteDanglingEdges(store, orgId);
        console.log(`audit: deleted ${deleted} dangling edge${deleted === 1 ? "" : "s"}.`);
      }
    } finally {
      await store.close();
    }
  } catch (e) {
    if (e instanceof SfgraphError) {
      console.error(`[${e.code}] ${e.message}`);
    } else {
      console.error((e as Error).message);
    }
    process.exitCode = 1;
  }
}

// Silence unused-import warning when tree-shaking discards `asOrgId`.
void asOrgId;
