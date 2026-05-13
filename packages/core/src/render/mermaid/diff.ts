import { fenceLabel, mermaidId } from "./shared.js";

export interface DiffNode {
  qualifiedName: string;
  label?: string;
}

export interface RenderDiffOpts {
  added: DiffNode[];
  removed: DiffNode[];
  changed: DiffNode[];
  title?: string;
}

export function renderDiff(opts: RenderDiffOpts): string {
  const { added, removed, changed, title } = opts;
  const lines: string[] = ["flowchart LR"];
  if (title) lines.push(`  %% ${title.replace(/\n/g, " ")}`);
  const emit = (n: DiffNode, cls: string) => {
    const id = mermaidId(n.qualifiedName);
    lines.push(`  ${id}[${fenceLabel(n.qualifiedName)}]:::${cls}`);
  };
  for (const n of added) emit(n, "added");
  for (const n of removed) emit(n, "removed");
  for (const n of changed) emit(n, "changed");
  lines.push("  classDef added fill:#2ecc71,color:#fff,stroke:#27ae60");
  lines.push("  classDef removed fill:#e74c3c,color:#fff,stroke:#c0392b");
  lines.push("  classDef changed fill:#f1c40f,color:#000,stroke:#f39c12");
  return lines.join("\n");
}
