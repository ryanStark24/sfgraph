import { fenceLabel, mermaidId } from "./shared.js";

export interface FlowStep {
  id: string;
  label: string;
  kind?: "decision" | "action" | "start" | "end";
}

export interface FlowBranch {
  fromId: string;
  toId: string;
  label?: string;
}

export interface RenderFlowchartOpts {
  start: string;
  steps: FlowStep[];
  branches?: FlowBranch[];
  title?: string;
}

export function renderFlowchart(opts: RenderFlowchartOpts): string {
  const { steps, branches = [], title } = opts;
  const lines: string[] = ["flowchart TD"];
  if (title) lines.push(`  %% ${title.replace(/\n/g, " ")}`);
  for (const s of steps) {
    const id = mermaidId(s.id);
    const lbl = fenceLabel(s.label);
    if (s.kind === "decision") lines.push(`  ${id}{${lbl}}`);
    else if (s.kind === "start" || s.kind === "end") lines.push(`  ${id}([${lbl}])`);
    else lines.push(`  ${id}[${lbl}]`);
  }
  for (const b of branches) {
    const lbl = b.label ? `|${b.label.replace(/\|/g, "/")}|` : "";
    lines.push(`  ${mermaidId(b.fromId)} -->${lbl} ${mermaidId(b.toId)}`);
  }
  return lines.join("\n");
}
