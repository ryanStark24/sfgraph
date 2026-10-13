import { describe, expect, it } from "vitest";
import {
  fenceLabel,
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

  // Cycle 2 T5 fix round 1: labels are full qnames (a reader copies them; a 27-char cut made
  // distinct nodes look alike), cut only past 100 chars.
  it("sanitizeLabel keeps names up to 100 chars, cuts longer ones, and escapes", () => {
    const qn = "CustomObject:ACME_CUTOVER_DATETIME__mdt";
    expect(sanitizeLabel(qn)).toBe(qn);
    const long = "x".repeat(150);
    const s = sanitizeLabel(long);
    expect(s.length).toBe(100);
    expect(s.endsWith("…")).toBe(true);
    // Sequence text: quotes and semicolons break it, parentheses and brackets do not.
    expect(sanitizeLabel('a"b;c[d](e)')).toBe("a'b,c[d](e)");
    expect(
      renderSequence({ participants: [{ id: "m", label: "ApexMethod:C.m(1)" }], messages: [] }),
    ).toContain("participant m as ApexMethod:C.m(1)");
  });

  it("fenceLabel keeps parentheses and brackets inside the quotes (a method qname stays exact)", () => {
    const out = renderDependencyGraph({
      nodes: [
        { qualifiedName: "ApexMethod:Svc.run(2)", label: "ApexMethod" },
        { qualifiedName: "ApexClass:Svc", label: "ApexClass" },
      ],
      edges: [],
    });
    expect(out).toContain('ApexMethod_Svc_run_2_["ApexMethod:Svc.run(2)"]');
    expect(
      renderDependencyGraph({ nodes: [{ qualifiedName: 'A"q', label: "X" }], edges: [] }),
    ).toContain('["A#quot;q"]');
  });

  it("renderDependencyGraph draws one edge per node pair, rel types joined", () => {
    const out = renderDependencyGraph({
      nodes: [
        { qualifiedName: "A", label: "ApexClass" },
        { qualifiedName: "B", label: "ApexClass" },
      ],
      edges: [
        { srcQualifiedName: "A", dstQualifiedName: "B", relType: "REFERENCES" },
        { srcQualifiedName: "A", dstQualifiedName: "B", relType: "INSTANCE_OF" },
        { srcQualifiedName: "A", dstQualifiedName: "B", relType: "REFERENCES" },
        { srcQualifiedName: "B", dstQualifiedName: "A", relType: "CALLS" },
      ],
    });
    const arrows = out.split("\n").filter((l) => l.includes("-->"));
    expect(arrows).toEqual(["  A -->|REFERENCES, INSTANCE_OF| B", "  B -->|CALLS| A"]);
  });

  it("fenceLabel keeps a label on one line, escapes # and cuts on code points (final review M5)", () => {
    expect(fenceLabel("a\n  b")).toBe('"a b"');
    expect(fenceLabel('C#"x')).toBe('"C#35;#quot;x"');
    const emoji = "😀".repeat(150);
    const out = fenceLabel(emoji);
    expect(out).toBe(`"${"😀".repeat(99)}…"`);
  });

  it("renderDiff gives every node its own id, even names that differ only in non-ASCII (M6)", () => {
    const out = renderDiff({
      added: [{ qualifiedName: "ApexClass:Café" }],
      removed: [{ qualifiedName: "ApexClass:Cafè" }],
      changed: [],
    });
    const ids = out
      .split("\n")
      .filter((l) => l.includes(":::"))
      .map((l) => l.trim().split("[")[0]);
    expect(ids).toEqual(["n0", "n1"]);
    expect(out).toContain('n0["ApexClass:Café"]:::added');
  });
});
