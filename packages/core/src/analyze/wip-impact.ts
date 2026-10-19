import * as fs from "node:fs";
import * as path from "node:path";
import type { Logger, OrgId } from "@ryanstark24/sfgraph-shared";
import { asQualifiedName } from "@ryanstark24/sfgraph-shared";
import type { NodeFact } from "../domain/index.js";
import { FilesystemMetadataSource } from "../extractors/filesystem/index.js";
import type { RawMember } from "../extractors/interfaces/metadata-source.js";
import { adaptParserInput } from "../ingest/live-ingest.js";
import type { ParseContext, ParseResult } from "../parsers/contract.js";
// Side-effect: ensure all built-in parsers are registered.
import "../parsers/index.js";
import { REL_TYPES } from "../domain/index.js";
import { parserRegistry } from "../parsers/registry.js";
import { loadAllRules } from "../parsers/rules/_loader.js";
import { fenceLabel, mermaidId, truncateByCentrality } from "../render/mermaid/shared.js";
import type { GraphStore } from "../storage/interfaces.js";
import { isMemberContainmentEdge } from "./containment.js";
import { findDependents } from "./dependents.js";
import { pathToQualifiedName } from "./path-to-qname.js";
import { codePointCompare } from "./pseudo-endpoints.js";
import { hasTestCoverage, makeCoverageClassifier } from "./test-coverage.js";
import {
  heldByMember,
  localChangedFiles,
  memberPath,
  selectOwningMembers,
} from "./wip-changed-files.js";

export interface WipDependent {
  qname: string;
  label: string;
  depth: number;
  viaRelType: string;
  coveredByTest: boolean;
}

/** An Apex class or trigger without test coverage (wip_test_gap). */
export interface WipTestGap extends WipDependent {
  /** Set when the component is itself a local change (depth 0). */
  seed?: "changed" | "added";
}

/**
 * Coverage of the changed / added components and their dependents, at
 * component level (a method is its class; containment.ts `componentOf`).
 * Every list is sorted by qname (code point).
 */
export interface WipTestGapResult {
  /** ApexClass / ApexTrigger components no test class exercises. */
  uncovered: WipTestGap[];
  /** ApexClass / ApexTrigger components a test class targets. */
  covered: string[];
  /** Test classes (skipped: a test is not a coverage gap). */
  tests: string[];
  /** Components no test can carry coverage for (LWC, Aura, Flow, ...). */
  notApplicable: string[];
}

export interface WipImpactResult {
  changedQnames: string[];
  addedQnames: string[];
  removedQnames: string[];
  dependents: WipDependent[];
  mermaid: string;
  /**
   * The nodes and links the mermaid is drawn from (seeds and dependents; dependent links as the
   * traversal's row edges), for callers that draw their own picture.
   */
  graph: {
    nodes: Array<{ qualifiedName: string; label: string }>;
    edges: Array<{ srcQualifiedName: string; dstQualifiedName: string; relType?: string }>;
  };
  /** Set when removed-qname detection in full-folder mode hit the per-label cap. */
  truncated?: boolean;
  /** Present when `testGaps` was requested. */
  testGaps?: WipTestGapResult;
}

export const WIP_REMOVED_SCAN_CAP = 10000;

export interface AnalyzeLocalImpactOpts {
  graphStore: GraphStore;
  orgId: OrgId;
  projectRoot: string;
  depth?: number;
  /**
   * `changed-only` (default): parse only members whose files changed locally
   * (differ from git HEAD, or modified after the org's `lastSyncedAt`); with
   * neither signal available every member is parsed. `full-folder`: parse the
   * whole tree and also report removed members.
   */
  mode?: "changed-only" | "full-folder";
  /**
   * Skip the reverse-dependency pass (wip_diff needs only the sets):
   * `dependents` is empty and the mermaid shows the changed / added nodes only.
   */
  skipDependents?: boolean;
  /** Also classify the seeds and dependents for test coverage (`testGaps`). */
  testGaps?: boolean;
  logger?: Logger;
}

const NOOP_LOG: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

/**
 * The ingest adapter, shared so a local parse produces the same parser input
 * (and so the same node `sourceHash`) as the ingest that built the graph.
 * wip used to carry its own copy without the Vlocity/OmniStudio cases, so
 * every DataPack parsed as an opaque node and reported "changed". Re-exported
 * for existing callers.
 */
export { adaptParserInput };

const WIP_COLORS = {
  changed: "#d0021b",
  added: "#4a90e2",
  risk: "#f5a623",
  safe: "#7ed321",
  removed: "#9b9b9b",
} as const;

export async function analyzeLocalImpact(opts: AnalyzeLocalImpactOpts): Promise<WipImpactResult> {
  const logger = opts.logger ?? NOOP_LOG;
  const depth = opts.depth ?? 3;
  const mode = opts.mode ?? "changed-only";

  // Ensure YAML-driven parsers are loaded (idempotent).
  try {
    await loadAllRules();
  } catch (e) {
    logger.warn("wip-impact: rule load failed", { err: (e as Error).message });
  }

  const source = FilesystemMetadataSource.fromProjectRoot(opts.projectRoot);
  const parseCtxBase: Omit<ParseContext, "sourceUri"> = {
    orgId: opts.orgId,
    parseTimestamp: new Date().toISOString(),
    namespace: null,
    logger,
  };

  const localNodes = new Map<string, NodeFact>();
  // Local containment and IS_TEST_FOR facts, for coverage of components the
  // graph does not hold yet (an added class, a new test).
  const localOwners = new Map<string, string>();
  const localTestTargets = new Set<string>();
  const localTestSources = new Set<string>();
  /** Paths of members that were read but produced no nodes. */
  const unparsedPaths = new Set<string>();
  const parseMember = async (member: RawMember): Promise<void> => {
    const fail = (): void => {
      unparsedPaths.add(memberPath(member.ref));
    };
    const adapted = adaptParserInput(member.ref, member.content);
    if (!adapted) return fail();
    const parser = parserRegistry.for(adapted.type);
    if (!parser) return fail();
    try {
      const ctx: ParseContext = {
        ...parseCtxBase,
        sourceUri: member.ref.sourceUri,
        namespace: member.ref.namespace ?? null,
      };
      const parsed: ParseResult = await parser.parse(adapted.input, ctx);
      for (const n of parsed.nodes) {
        localNodes.set(String(n.qualifiedName), n);
      }
      for (const e of parsed.edges ?? []) {
        if (isMemberContainmentEdge(e)) {
          localOwners.set(String(e.dstQualifiedName), String(e.srcQualifiedName));
        } else if (String(e.relType) === REL_TYPES.IS_TEST_FOR) {
          localTestTargets.add(String(e.dstQualifiedName).toLowerCase());
          localTestSources.add(String(e.srcQualifiedName).toLowerCase());
        }
      }
      if (parsed.nodes.length === 0) fail();
    } catch (e) {
      fail();
      logger.warn("wip-impact: parse failure", {
        type: member.ref.memberType,
        name: member.ref.memberName,
        err: (e as Error).message,
      });
    }
  };

  // changed-only: parse only the members owning locally changed files (git or
  // mtime after the last sync). The tree is indexed once (directory listings
  // and stats, no reads) and only the members that can own a changed file, or
  // decide who owns one, are load()ed (`selectOwningMembers`).
  const sourceDirs = [
    ...source.packageDirs.map((d) => path.resolve(source.rootDir, d)),
    path.resolve(source.rootDir, "vlocity", "datapacks"),
  ];
  const changedFiles =
    mode === "changed-only"
      ? localChangedFiles({
          projectRoot: opts.projectRoot,
          sourceDirs,
          lastSyncedAt: opts.graphStore.getOrg(opts.orgId)?.lastSyncedAt,
          logger,
        })
      : null;
  if (!changedFiles) {
    for await (const member of source.iter()) await parseMember(member);
  } else if (changedFiles.size > 0) {
    const sel = await selectOwningMembers(source.iterIndexed(), changedFiles, async (entry) => {
      const m = await entry.load();
      return m && !m.unreadable ? m : null;
    });
    for (const m of sel.direct) await parseMember(m);
    for (const m of sel.owners) await parseMember(m);
    for (const p of sel.dropped) unparsedPaths.add(p);
    logger.debug("wip-impact: changed-only selection", {
      changedFiles: changedFiles.size,
      members: sel.direct.length + sel.owners.length,
      loaded: sel.loaded,
      of: sel.indexed,
    });
  }

  // Compare against persisted store.
  const changedQnames: string[] = [];
  const addedQnames: string[] = [];
  for (const [qn, localNode] of localNodes) {
    const persisted = opts.graphStore.getNode(opts.orgId, asQualifiedName(qn));
    if (!persisted) {
      addedQnames.push(qn);
      continue;
    }
    if (String(persisted.sourceHash) !== String(localNode.sourceHash)) {
      changedQnames.push(qn);
    }
  }

  // Removed. changed-only: deleted files (below). full-folder: qnames present
  // in persisted store but absent from local source. We approximate this by scanning persisted nodes whose
  // labels match categories the local walker is responsible for. Keeping it
  // tight: only signal removed for qnames that share a memberType-prefix with
  // some local node OR are of a label we walked.
  const removedQnames: string[] = [];
  let truncated = false;
  if (changedFiles) {
    // A deleted file is a changed path that yields no member: map it to its
    // qualified name and report the persisted node as removed. Limits:
    //  - only paths under the source dirs (package dirs, DataPacks), mapped
    //    from their project-relative path;
    //  - only the types `pathToQualifiedName` maps (every single-file parsed
    //    type and the bundle types): a deleted DataPack or a multi-item file
    //    is not reported.
    // Removed qnames seed the dependents pass (T15 I-6): what referenced a
    // deleted component is impacted.
    // Not removed: a member a local node still produces (compared without
    // case, as the store is), or a surviving member holding the file (a
    // bundle that lost one file, a class whose sidecar was deleted) that could
    // not be read or parsed.
    const localLower = new Set([...localNodes.keys()].map((k) => k.toLowerCase()));
    const seenRemoved = new Set<string>();
    const root = path.resolve(opts.projectRoot);
    for (const f of changedFiles) {
      const abs = path.resolve(f);
      if (!sourceDirs.some((d) => abs.startsWith(`${d}${path.sep}`))) continue;
      if (fs.existsSync(abs) || heldByMember(abs, unparsedPaths)) continue;
      const qn = pathToQualifiedName(path.relative(root, abs));
      if (!qn || localLower.has(String(qn).toLowerCase())) continue;
      const persisted = opts.graphStore.getNode(opts.orgId, qn);
      if (!persisted) continue;
      const pqn = String(persisted.qualifiedName);
      const key = pqn.toLowerCase();
      if (localLower.has(key) || seenRemoved.has(key)) continue;
      seenRemoved.add(key);
      removedQnames.push(pqn);
    }
  }
  if (mode === "full-folder") {
    const walkedLabels = new Set<string>();
    for (const n of localNodes.values()) walkedLabels.add(n.label);
    // GraphStore has no global "listAll" — but we know the labels we touched.
    // For each walked label scan persisted nodes by label.
    for (const label of walkedLabels) {
      const persistedNodes = opts.graphStore.listNodesByLabel(
        opts.orgId,
        label,
        WIP_REMOVED_SCAN_CAP,
      );
      if (persistedNodes.length >= WIP_REMOVED_SCAN_CAP) truncated = true;
      for (const pn of persistedNodes) {
        const qn = String(pn.qualifiedName);
        if (!localNodes.has(qn)) {
          removedQnames.push(qn);
        }
      }
    }
  }

  // Reverse BFS from changed+added+removed seeds (T15 I-6: a removed node's
  // dependents are the references the removal breaks).
  const seedQnames = [...changedQnames, ...addedQnames, ...removedQnames];
  const dependents: WipDependent[] = [];
  // node map for mermaid
  const nodeMap = new Map<string, { qualifiedName: string; label: string }>();
  const edgeList: Array<{ srcQualifiedName: string; dstQualifiedName: string; relType?: string }> =
    [];
  // Seed nodes — include in node map with label from persisted store or local
  for (const qn of seedQnames) {
    const persisted = opts.graphStore.getNode(opts.orgId, asQualifiedName(qn));
    const local = localNodes.get(qn);
    const label = local?.label ?? persisted?.label ?? "Changed";
    nodeMap.set(qn, { qualifiedName: qn, label });
  }

  const seenDep = new Set<string>();
  for (const qn of opts.skipDependents ? [] : seedQnames) {
    const qname = asQualifiedName(qn);
    // wip_impact's contract is component-level ("every component that
    // depends on a changed component"): callers of any member of a reached
    // component count. trace_upstream keeps the member-precise default.
    const result = findDependents(opts.graphStore, opts.orgId, qname, depth, {
      componentHops: true,
    });
    // Depth / rel from the traversal's own rows: containment (folded Flow
    // rows, component-level Apex hops) has no edge to re-derive it from.
    const dist = new Map<string, { d: number; viaRel: string }>();
    for (const row of result.reached ?? []) {
      dist.set(row.qualifiedName, { d: row.hop, viaRel: row.relType });
    }
    // Record dependents (skip seed itself)
    for (const n of result.nodes) {
      const nqn = String(n.qualifiedName);
      nodeMap.set(nqn, { qualifiedName: nqn, label: n.label });
      if (seenDep.has(nqn)) continue;
      seenDep.add(nqn);
      const info = dist.get(nqn);
      const covered = hasTestCoverage(opts.graphStore, opts.orgId, n.qualifiedName);
      dependents.push({
        qname: nqn,
        label: n.label,
        depth: info?.d ?? 1,
        viaRelType: info?.viaRel ?? "",
        coveredByTest: covered,
      });
    }
    for (const e of result.rowEdges ?? result.edges) {
      edgeList.push({
        srcQualifiedName: String(e.srcQualifiedName),
        dstQualifiedName: String(e.dstQualifiedName),
        relType: e.relType,
      });
    }
  }

  let testGaps: WipTestGapResult | undefined;
  if (opts.testGaps) {
    const classify = makeCoverageClassifier(opts.graphStore, opts.orgId, {
      nodes: localNodes,
      owners: localOwners,
      testTargets: localTestTargets,
      testSources: localTestSources,
    });
    const units = new Map<string, WipTestGap & { v: ReturnType<typeof classify> }>();
    const consider = (q: string, d: number, via: string, seed?: "changed" | "added"): void => {
      const v = classify(q);
      const cur = units.get(v.unit);
      if (!cur) {
        units.set(v.unit, {
          qname: v.unit,
          label: v.label,
          depth: d,
          viaRelType: via,
          coveredByTest: v.covered,
          ...(seed ? { seed } : {}),
          v,
        });
        return;
      }
      // A seed beats a dependent; a "changed" seed beats an "added" one; else
      // the lower depth wins.
      if (seed && (cur.seed === undefined || (seed === "changed" && cur.seed === "added"))) {
        cur.seed = seed;
        cur.depth = 0;
        cur.viaRelType = "";
      } else if (!cur.seed && !seed && d < cur.depth) {
        cur.depth = d;
        cur.viaRelType = via;
      }
    };
    for (const q of changedQnames) consider(q, 0, "", "changed");
    for (const q of addedQnames) consider(q, 0, "", "added");
    for (const d of dependents) consider(d.qname, d.depth, d.viaRelType);
    const sorted = [...units.values()].sort((a, b) => codePointCompare(a.qname, b.qname));
    testGaps = {
      uncovered: sorted
        .filter((u) => u.v.applicable && !u.v.isTest && !u.v.covered)
        .map(({ v: _v, ...rest }) => rest),
      covered: sorted
        .filter((u) => u.v.applicable && !u.v.isTest && u.v.covered)
        .map((u) => u.qname),
      tests: sorted.filter((u) => u.v.isTest).map((u) => u.qname),
      notApplicable: sorted.filter((u) => !u.v.applicable && !u.v.isTest).map((u) => u.qname),
    };
  }

  // Build Mermaid with WIP class defs.
  const mermaid = renderWipMermaid({
    nodes: Array.from(nodeMap.values()),
    edges: edgeList,
    changed: new Set(changedQnames),
    added: new Set(addedQnames),
    removed: new Set(removedQnames),
    dependents,
  });

  return {
    changedQnames,
    addedQnames,
    removedQnames,
    dependents,
    mermaid,
    graph: { nodes: Array.from(nodeMap.values()), edges: edgeList },
    truncated,
    ...(testGaps ? { testGaps } : {}),
  };
}

interface RenderOpts {
  nodes: Array<{ qualifiedName: string; label: string }>;
  edges: Array<{ srcQualifiedName: string; dstQualifiedName: string; relType?: string }>;
  changed: Set<string>;
  added: Set<string>;
  removed: Set<string>;
  dependents: WipDependent[];
}

function renderWipMermaid(opts: RenderOpts): string {
  const { kept, truncated } = truncateByCentrality(opts.nodes, opts.edges, 40);
  const keptSet = new Set(kept.map((n) => n.qualifiedName));
  const lines: string[] = [];
  lines.push("flowchart LR");
  lines.push(`  classDef wip-changed fill:${WIP_COLORS.changed},color:#fff,stroke:#333`);
  lines.push(`  classDef wip-added fill:${WIP_COLORS.added},color:#fff,stroke:#333`);
  lines.push(`  classDef risk fill:${WIP_COLORS.risk},color:#000,stroke:#333`);
  lines.push(`  classDef safe fill:${WIP_COLORS.safe},color:#000,stroke:#333`);
  const anyRemoved = kept.some((n) => opts.removed.has(n.qualifiedName));
  if (anyRemoved) {
    lines.push(`  classDef wip-removed fill:${WIP_COLORS.removed},color:#fff,stroke:#333`);
  }

  const depCovered = new Map<string, boolean>();
  for (const d of opts.dependents) depCovered.set(d.qname, d.coveredByTest);

  for (const n of kept) {
    const id = mermaidId(n.qualifiedName);
    const label = fenceLabel(n.qualifiedName);
    lines.push(`  ${id}[${label}]`);
  }
  if (truncated > 0) lines.push(`  __more["(+${truncated} more)"]`);
  for (const e of opts.edges) {
    if (!keptSet.has(e.srcQualifiedName) || !keptSet.has(e.dstQualifiedName)) continue;
    const a = mermaidId(e.srcQualifiedName);
    const b = mermaidId(e.dstQualifiedName);
    const lbl = e.relType ? `|${e.relType}|` : "";
    lines.push(`  ${a} -->${lbl} ${b}`);
  }
  for (const n of kept) {
    const id = mermaidId(n.qualifiedName);
    if (opts.changed.has(n.qualifiedName)) {
      lines.push(`  class ${id} wip-changed`);
    } else if (opts.removed.has(n.qualifiedName)) {
      lines.push(`  class ${id} wip-removed`);
    } else if (opts.added.has(n.qualifiedName)) {
      lines.push(`  class ${id} wip-added`);
    } else if (depCovered.has(n.qualifiedName)) {
      const covered = depCovered.get(n.qualifiedName);
      lines.push(`  class ${id} ${covered ? "safe" : "risk"}`);
    }
  }
  return lines.join("\n");
}
