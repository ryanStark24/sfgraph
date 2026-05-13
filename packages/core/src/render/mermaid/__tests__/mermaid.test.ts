import { describe, expect, it } from "vitest";
import {
  renderDependencyGraph,
  renderDiff,
  renderFlowchart,
  renderSequence,
  sanitizeLabel,
  truncateByCentrality,
} from "../index.js";

describe("mermaid render layer", () => {
  it("renderDependencyGraph starts with flowchart and has no triple backticks", () => {
    const out = renderDependencyGraph({
      nodes: [
        { qualifiedName: "A", label: "ApexClass" },
        { qualifiedName: "B", label: "LWC" },
      ],
      edges: [{ srcQualifiedName: "A", dstQualifiedName: "B" }],
    });
    expect(out.startsWith("flowchart")).toBe(true);
    expect(out).not.toContain("```");
  });

  it("renderSequence starts with sequenceDiagram", () => {
    const out = renderSequence({
      participants: [
        { id: "L", label: "LWC", layer: "LWC" },
        { id: "A", label: "Apex", layer: "Apex" },
      ],
      messages: [{ fromId: "L", toId: "A", label: "call" }],
    });
    expect(out.startsWith("sequenceDiagram")).toBe(true);
    expect(out).not.toContain("```");
  });

  it("renderDiff applies added/removed/changed classes", () => {
    const out = renderDiff({
      added: [{ qualifiedName: "A" }],
      removed: [{ qualifiedName: "B" }],
      changed: [{ qualifiedName: "C" }],
    });
    expect(out).toContain("classDef added");
    expect(out).toContain("classDef removed");
    expect(out).toContain("classDef changed");
    expect(out).not.toContain("```");
  });

  it("renderFlowchart emits flowchart TD", () => {
    const out = renderFlowchart({
      start: "s",
      steps: [
        { id: "s", label: "start", kind: "start" },
        { id: "e", label: "end", kind: "end" },
      ],
      branches: [{ fromId: "s", toId: "e" }],
    });
    expect(out.startsWith("flowchart TD")).toBe(true);
    expect(out).not.toContain("```");
  });

  it("truncateByCentrality picks top-N by degree", () => {
    const nodes = Array.from({ length: 50 }, (_, i) => ({
      qualifiedName: `n${i}`,
      label: "X",
    }));
    const edges: Array<{ srcQualifiedName: string; dstQualifiedName: string }> = [];
    // make n0 very central
    for (let i = 1; i < 50; i++) {
      edges.push({ srcQualifiedName: "n0", dstQualifiedName: `n${i}` });
    }
    const r = truncateByCentrality(nodes, edges, 10);
    expect(r.kept.length).toBe(10);
    expect(r.truncated).toBe(40);
    expect(r.kept[0]?.qualifiedName).toBe("n0");
  });

  it("sanitizeLabel truncates and escapes", () => {
    const long = "x".repeat(50);
    const s = sanitizeLabel(long);
    expect(s.length).toBeLessThanOrEqual(30);
    expect(s.endsWith("…")).toBe(true);
    const escaped = sanitizeLabel('a"b[c]d(e)f');
    expect(escaped).not.toContain('"');
    expect(escaped).not.toMatch(/[\[\]\(\)]/);
  });
});
