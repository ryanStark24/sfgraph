import type { Logger, OrgId } from "@ryanstark24/sfgraph-shared";
import { asQualifiedName } from "@ryanstark24/sfgraph-shared";
import type { NodeFact } from "../domain/index.js";
import { FilesystemMetadataSource } from "../extractors/filesystem/index.js";
import type { MemberRef, RawMember } from "../extractors/interfaces/metadata-source.js";
import type { ParseContext, ParseResult } from "../parsers/contract.js";
// Side-effect: ensure all built-in parsers are registered.
import "../parsers/index.js";
import { parserRegistry } from "../parsers/registry.js";
import { loadAllRules } from "../parsers/rules/_loader.js";
import { fenceLabel, mermaidId, truncateByCentrality } from "../render/mermaid/shared.js";
import type { GraphStore } from "../storage/interfaces.js";
import { findDependents } from "./dependents.js";
import { hasTestCoverage } from "./test-coverage.js";

export interface WipDependent {
  qname: string;
  label: string;
  depth: number;
  viaRelType: string;
  coveredByTest: boolean;
}

export interface WipImpactResult {
  changedQnames: string[];
  addedQnames: string[];
  removedQnames: string[];
  dependents: WipDependent[];
  mermaid: string;
}

export interface AnalyzeLocalImpactOpts {
  graphStore: GraphStore;
  orgId: OrgId;
  projectRoot: string;
  depth?: number;
  mode?: "changed-only" | "full-folder";
  logger?: Logger;
}

const NOOP_LOG: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

// Mirrors live-ingest's adapter so registry input shapes match.
function adaptParserInput(
  ref: MemberRef,
  content: string,
): { type: string; input: unknown } | null {
  switch (ref.memberType) {
    case "ApexClass":
      return { type: "ApexClass", input: { className: ref.memberName, body: content } };
    case "ApexTrigger":
      return { type: "ApexTrigger", input: { triggerName: ref.memberName, body: content } };
    case "LightningComponentBundle": {
      try {
        const parsed = JSON.parse(content || "{}") as {
          bundleName?: string;
          files?: Record<string, string>;
        };
        return {
          type: "LightningComponentBundle",
          input: { bundleName: parsed.bundleName ?? ref.memberName, files: parsed.files ?? {} },
        };
      } catch {
        return null;
      }
    }
    case "Flow":
      return { type: "Flow", input: { fullName: ref.memberName, xml: content } };
    case "CustomObject": {
      // Filesystem source bundles fields/recordTypes/validationRules in JSON content.
      try {
        const parsed = JSON.parse(content) as {
          apiName?: string;
          objectXml?: string;
          fields?: Record<string, string>;
          recordTypes?: Record<string, string>;
          validationRules?: Record<string, string>;
        };
        return {
          type: "CustomObject",
          input: {
            apiName: parsed.apiName ?? ref.memberName,
            objectXml: parsed.objectXml ?? "",
            fields: parsed.fields ?? {},
            recordTypes: parsed.recordTypes ?? {},
            validationRules: parsed.validationRules ?? {},
          },
        };
      } catch {
        return { type: "CustomObject", input: { apiName: ref.memberName, objectXml: content } };
      }
    }
    case "Profile":
      return { type: "Profile", input: { name: ref.memberName, xml: content } };
    case "PermissionSet":
      return { type: "PermissionSet", input: { name: ref.memberName, xml: content } };
    case "PermissionSetGroup":
      return { type: "PermissionSetGroup", input: { name: ref.memberName, xml: content } };
    case "SharingRules":
      return { type: "SharingRules", input: { object: ref.memberName, xml: content } };
    case "NamedCredential":
      return { type: "NamedCredential", input: { name: ref.memberName, xml: content } };
    case "ExternalServiceRegistration":
      return {
        type: "ExternalServiceRegistration",
        input: { name: ref.memberName, xml: content },
      };
    case "ApexPage":
      return { type: "ApexPage", input: { name: ref.memberName, xml: content } };
    case "ApexComponent":
      return { type: "ApexComponent", input: { name: ref.memberName, xml: content } };
    case "Layout":
      return { type: "Layout", input: { name: ref.memberName, xml: content } };
    case "FlexiPage":
      return { type: "FlexiPage", input: { name: ref.memberName, xml: content } };
    case "CustomMetadata":
      return { type: "CustomMetadata", input: { name: ref.memberName, xml: content } };
    case "CustomLabels":
      return { type: "CustomLabels", input: { name: ref.memberName, xml: content } };
    case "Workflow":
      return { type: "Workflow", input: { name: ref.memberName, xml: content } };
    case "ApprovalProcess":
      return { type: "ApprovalProcess", input: { name: ref.memberName, xml: content } };
    case "DuplicateRule":
      return { type: "DuplicateRule", input: { name: ref.memberName, xml: content } };
    default:
      return null;
  }
}

const WIP_COLORS = {
  changed: "#d0021b",
  added: "#4a90e2",
  risk: "#f5a623",
  safe: "#7ed321",
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

  // Collect local nodes (qname -> { node, viaSourceHash }).
  const localNodes = new Map<string, NodeFact>();
  for await (const member of source.iter()) {
    const adapted = adaptParserInput(member.ref, member.content);
    if (!adapted) continue;
    const parser = parserRegistry.for(adapted.type);
    if (!parser) continue;
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
    } catch (e) {
      logger.warn("wip-impact: parse failure", {
        type: member.ref.memberType,
        name: member.ref.memberName,
        err: (e as Error).message,
      });
    }
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

  // Removed (full-folder only): qnames present in persisted store but absent
  // from local source. We approximate this by scanning persisted nodes whose
  // labels match categories the local walker is responsible for. Keeping it
  // tight: only signal removed for qnames that share a memberType-prefix with
  // some local node OR are of a label we walked.
  const removedQnames: string[] = [];
  if (mode === "full-folder") {
    const walkedLabels = new Set<string>();
    for (const n of localNodes.values()) walkedLabels.add(n.label);
    // GraphStore has no global "listAll" — but we know the labels we touched.
    // For each walked label scan persisted nodes by label.
    for (const label of walkedLabels) {
      const persistedNodes = opts.graphStore.listNodesByLabel(opts.orgId, label, 10000);
      for (const pn of persistedNodes) {
        const qn = String(pn.qualifiedName);
        if (!localNodes.has(qn)) {
          removedQnames.push(qn);
        }
      }
    }
  }

  // Reverse BFS from changed+added seeds.
  const seedQnames = [...changedQnames, ...addedQnames];
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
  for (const qn of seedQnames) {
    const qname = asQualifiedName(qn);
    const result = findDependents(opts.graphStore, opts.orgId, qname, depth);
    // Build BFS depth per node by walking again to assign depth.
    // findDependents doesn't return depth; recompute simple BFS using its
    // edges for richer info.
    // Build adjacency from result edges (dst -> [{src, relType}])
    const adj = new Map<string, Array<{ src: string; relType: string }>>();
    for (const e of result.edges) {
      const list = adj.get(String(e.dstQualifiedName)) ?? [];
      list.push({ src: String(e.srcQualifiedName), relType: e.relType });
      adj.set(String(e.dstQualifiedName), list);
    }
    // BFS from seed
    const dist = new Map<string, { d: number; viaRel: string }>();
    dist.set(qn, { d: 0, viaRel: "" });
    const queue: string[] = [qn];
    while (queue.length > 0) {
      const cur = queue.shift();
      if (!cur) break;
      const curD = dist.get(cur)?.d ?? 0;
      if (curD >= depth) continue;
      const incoming = adj.get(cur) ?? [];
      for (const inc of incoming) {
        if (dist.has(inc.src)) continue;
        dist.set(inc.src, { d: curD + 1, viaRel: inc.relType });
        queue.push(inc.src);
      }
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
    for (const e of result.edges) {
      edgeList.push({
        srcQualifiedName: String(e.srcQualifiedName),
        dstQualifiedName: String(e.dstQualifiedName),
        relType: e.relType,
      });
    }
  }

  // Build Mermaid with WIP class defs.
  const mermaid = renderWipMermaid({
    nodes: Array.from(nodeMap.values()),
    edges: edgeList,
    changed: new Set(changedQnames),
    added: new Set(addedQnames),
    dependents,
  });

  return {
    changedQnames,
    addedQnames,
    removedQnames,
    dependents,
    mermaid,
  };
}

interface RenderOpts {
  nodes: Array<{ qualifiedName: string; label: string }>;
  edges: Array<{ srcQualifiedName: string; dstQualifiedName: string; relType?: string }>;
  changed: Set<string>;
  added: Set<string>;
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
    } else if (opts.added.has(n.qualifiedName)) {
      lines.push(`  class ${id} wip-added`);
    } else if (depCovered.has(n.qualifiedName)) {
      const covered = depCovered.get(n.qualifiedName);
      lines.push(`  class ${id} ${covered ? "safe" : "risk"}`);
    }
  }
  return lines.join("\n");
}
