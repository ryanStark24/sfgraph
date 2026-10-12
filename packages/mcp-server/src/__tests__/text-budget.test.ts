import { describe, expect, it } from "vitest";
import { SfgraphMcpServer, TEXT_MAX, fitText } from "../server.js";
import { renderReport } from "../tools/_report.js";

// Cycle 2 T5 fix round 1: an MCP client sees only the result text, and a client may refuse a text
// over its own size limit (Claude Code saves it to a file the agent may not be allowed to read).
// The server cuts an over-budget text at a line boundary, outside any code fence, and says how
// to narrow the call, so the caller always gets a usable answer.
const lines = (n: number, w = 60) =>
  Array.from({ length: n }, (_, i) => `- ${String(i).padStart(5, "0")} ${"x".repeat(w)}`);

describe("tool text budget", () => {
  it("leaves a text within the budget unchanged", () => {
    const t = lines(10).join("\n");
    expect(fitText(t)).toBe(t);
  });

  it("cuts an over-budget text at a line boundary and says how many lines were left out", () => {
    const all = lines(1000);
    const out = fitText(all.join("\n"));
    expect(out.length).toBeLessThanOrEqual(TEXT_MAX);
    const kept = out.split("\n").filter((l) => l.startsWith("- "));
    expect(all.slice(0, kept.length)).toEqual(kept);
    expect(out).toMatch(new RegExp(`${all.length - kept.length} more lines not shown`));
    expect(out).toMatch(/narrow the call/i);
  });

  it("never leaves a code fence open: a cut inside a fence drops the whole fenced block", () => {
    const head = lines(20);
    const fence = ["```mermaid", "flowchart LR", ...lines(1000), "```"];
    const out = fitText([...head, "", ...fence].join("\n"));
    expect(out.length).toBeLessThanOrEqual(TEXT_MAX);
    expect(out).not.toMatch(/```/);
    expect(out.startsWith(head.join("\n"))).toBe(true);
    expect(out).toMatch(/more lines not shown/);
  });

  // T5 review fix 1: a first block that alone exceeds the room keeps the lines that fit (never only the note).
  const fences = (s: string) => s.split("\n").filter((l) => /^\s*```[\w+#.-]*\s*$/.test(l)).length;

  it("an oversize first fenced block keeps the lines that fit and closes the fence", () => {
    const out = fitText(["```apex", ...lines(1000), "```"].join("\n"));
    expect(out.length).toBeLessThanOrEqual(TEXT_MAX);
    expect(out.startsWith("```apex\n- 00000")).toBe(true);
    expect(fences(out) % 2).toBe(0);
    expect(out).toMatch(/more lines not shown/);
  });

  it("an oversize first line is cut rather than dropped", () => {
    const out = fitText("y".repeat(TEXT_MAX * 2));
    expect(out.length).toBeLessThanOrEqual(TEXT_MAX);
    expect(out.startsWith("yyyy")).toBe(true);
    expect(out).toMatch(/more lines not shown|Text cut/);
  });

  it("a ``` inside source text does not flip fence tracking", () => {
    const head = ["# Source", ""];
    const block = [
      "```apex",
      "String a = '```';",
      "```not a fence, text follows",
      "Integer b = 1;",
      "```",
    ];
    const tail = lines(1000);
    const out = fitText([...head, ...block, "", ...tail].join("\n"));
    expect(out.length).toBeLessThanOrEqual(TEXT_MAX);
    expect(out).toContain(block.join("\n"));
    expect(fences(out) % 2).toBe(0);
    expect(out).toMatch(/- 00000/);
    expect(out).toMatch(/more lines not shown/);
  });

  // Cycle 3 T2: a human report keeps its summary, picture and pieces; only Technical details are cut.
  const report = (pieceCount: number, detailLines: number, pieceWidth = 40) =>
    [
      "## What `CaseTrigger` depends on",
      "",
      "**In short**",
      "`CaseTrigger` relies on many other pieces.",
      "",
      "**Picture**",
      "",
      "```mermaid",
      "flowchart LR",
      '  n0["Apex class: A"] -->|calls| n1["Apex class: B"]',
      "```",
      "",
      "**What each piece does**",
      ...Array.from({ length: pieceCount }, (_, i) => `- \`P${i}\`: ${"r".repeat(pieceWidth)}`),
      "",
      "**Technical details**",
      "",
      ...lines(detailLines),
      "",
      "**What to check next**",
      "- Call again with a lower `depth`.",
    ].join("\n");

  it("cuts a report inside Technical details and keeps the sections before it whole", () => {
    const text = report(10, 1000);
    const out = fitText(text);
    expect(out.length).toBeLessThanOrEqual(TEXT_MAX);
    const head = text.slice(0, text.indexOf("**Technical details**"));
    expect(out.startsWith(head)).toBe(true);
    expect(out).toContain("**Technical details**\n\n- 00000");
    expect(out).toMatch(/more lines not shown/);
    expect(out).toContain("**What to check next**\n- Call again with a lower `depth`.");
    expect(fences(out) % 2).toBe(0);
  });

  it("cuts the pieces list first when the sections before Technical details exceed the limit", () => {
    const text = report(400, 50, 60);
    const out = fitText(text);
    expect(out.length).toBeLessThanOrEqual(TEXT_MAX);
    expect(out).toContain("**In short**\n`CaseTrigger` relies on many other pieces.");
    expect(out).toContain('n0["Apex class: A"]');
    expect(out).toContain("- `P0`: ");
    expect(out).not.toContain("- `P399`: ");
    expect(out).toMatch(/- and \d+ more pieces not shown/);
    expect(out).toContain("**Technical details**");
    expect(out).toMatch(/more lines not shown/);
  });

  it("a rendered report keeps its own piece count line, and adds dropped pieces to it", () => {
    const pieces = (n: number, w: number) =>
      Array.from({ length: n }, (_, i) => ({
        name: `P${i}`,
        kind: "ApexClass",
        role: "r".repeat(w),
      }));
    const r = { title: "T", inShort: ["Short."], details: lines(1000).join("\n") };
    const out = fitText(renderReport({ ...r, pieces: pieces(27, 10) }));
    expect(out.length).toBeLessThanOrEqual(TEXT_MAX);
    expect(out).toContain("- and 12 more, listed under Technical details\n\n**Technical details**");
    const big = fitText(renderReport({ ...r, pieces: pieces(27, 1500) }));
    expect(big.length).toBeLessThanOrEqual(TEXT_MAX);
    const shown = big.split("\n").filter((l) => l.startsWith("- `P")).length;
    expect(shown).toBeLessThan(15);
    expect(big).toContain(`- and ${27 - shown} more pieces not shown here`);
  });

  it("never splits a UTF-16 surrogate pair", () => {
    for (const pad of ["", "a"]) {
      const out = fitText(pad + "😀".repeat(TEXT_MAX));
      expect(out.length).toBeLessThanOrEqual(TEXT_MAX);
      const first = out.split("\n")[0]!;
      expect(/[\uD800-\uDBFF]$/.test(first)).toBe(false);
      expect(first.startsWith(`${pad}😀`)).toBe(true);
    }
  });

  it("dispatch applies the budget to the result text", async () => {
    const server = new SfgraphMcpServer();
    const big = lines(1000).join("\n");
    server.registry.register("probe_big", async () => ({ summary: "s", markdown: big, data: {} }), {
      description: "probe",
    });
    const res = await server.dispatch("probe_big", {});
    expect(res.content[0]?.text.length).toBeLessThanOrEqual(TEXT_MAX);
    expect(res.content[0]?.text).toMatch(/more lines not shown/);
  });
});
