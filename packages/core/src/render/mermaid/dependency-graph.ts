import {
  type CentralityEdge,
  type CentralityNode,
  colorForLabel,
  fenceLabel,
  mermaidId,
  truncateByCentrality,
} from "./shared.js";

export interface DepGraphNode extends CentralityNode {
  displayName?: string;
}

export interface DepGraphEdge extends CentralityEdge {
  relType?: string;
}

export interface RenderDependencyGraphOpts {
  nodes: DepGraphNode[];
  edges: DepGraphEdge[];
  title?: string;
  cap?: number;
}

export function renderDependencyGraph(opts: RenderDependencyGraphOpts): string {
  const { nodes, edges, title, cap = 40 } = opts;
  const { kept, truncated } = truncateByCentrality(nodes, edges, cap);
  const keptSet = new Set(kept.map((n) => n.qualifiedName));
  const lines: string[] = [];
  lines.push("flowchart LR");
  if (title) lines.push(`  %% ${title.replace(/\n/g, " ")}`);
  const labelClasses = new Map<string, string>();
  let classIdx = 0;
  for (const n of kept) {
    if (!labelClasses.has(n.label)) {
      labelClasses.set(n.label, `cls${classIdx++}`);
    }
  }
  for (const n of kept) {
    const id = mermaidId(n.qualifiedName);
    const label = fenceLabel(n.displayName ?? n.qualifiedName);
    lines.push(`  ${id}[${label}]`);
  }
  if (truncated > 0) {
    lines.push(`  __more["(+${truncated} more)"]`);
  }
  for (const e of edges) {
    if (!keptSet.has(e.srcQualifiedName) || !keptSet.has(e.dstQualifiedName)) continue;
    const a = mermaidId(e.srcQualifiedName);
    const b = mermaidId(e.dstQualifiedName);
    const lbl = e.relType ? `|${e.relType}|` : "";
    lines.push(`  ${a} -->${lbl} ${b}`);
  }
  for (const [label, cls] of labelClasses) {
    lines.push(
      `  classDef ${cls} fill:${colorForLabel(label)},color:#fff,stroke:#333,stroke-width:1px`,
    );
  }
  for (const n of kept) {
    const cls = labelClasses.get(n.label);
    if (cls) lines.push(`  class ${mermaidId(n.qualifiedName)} ${cls}`);
  }
  return lines.join("\n");
}
