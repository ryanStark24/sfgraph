import { mermaidId, sanitizeLabel } from "./shared.js";

export interface SequenceParticipant {
  id: string;
  label: string;
  layer?: "LWC" | "Apex" | "SOQL" | "Field" | string;
}

export interface SequenceMessage {
  fromId: string;
  toId: string;
  label: string;
  type?: "sync" | "async" | "return";
}

const LAYER_ORDER = ["LWC", "Apex", "SOQL", "Field"];

export function renderSequence(opts: {
  participants: SequenceParticipant[];
  messages: SequenceMessage[];
}): string {
  const { participants, messages } = opts;
  const sortedParticipants = [...participants].sort((a, b) => {
    const ai = LAYER_ORDER.indexOf(a.layer ?? "");
    const bi = LAYER_ORDER.indexOf(b.layer ?? "");
    return (ai < 0 ? 99 : ai) - (bi < 0 ? 99 : bi);
  });
  const lines: string[] = ["sequenceDiagram"];
  for (const p of sortedParticipants) {
    lines.push(`  participant ${mermaidId(p.id)} as ${sanitizeLabel(p.label)}`);
  }
  for (const m of messages) {
    const arrow = m.type === "async" ? "-)" : m.type === "return" ? "-->>" : "->>";
    lines.push(`  ${mermaidId(m.fromId)} ${arrow} ${mermaidId(m.toId)}: ${sanitizeLabel(m.label)}`);
  }
  return lines.join("\n");
}
