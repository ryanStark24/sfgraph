import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type Fixture, REL_TYPES, createFixture } from "./_fixture.js";
import { callTool, defaultRegistry } from "./_runner.js";

// Batch Q2 fix round 1: the tools state the Q2 behaviour (M2, docs). Cycle 3 T5: caveats about
// results moved from the descriptions (sent on every call) into the result text.
const desc = (name: string) => defaultRegistry.get(name)?.schema.description ?? "";

let fix: Fixture;
let projectRoot: string;

beforeEach(async () => {
  fix = await createFixture();
  projectRoot = mkdtempSync(path.join(tmpdir(), "sfg-q2-desc-"));
});

afterEach(async () => {
  await fix.cleanup();
  rmSync(projectRoot, { recursive: true, force: true });
});

/** The result of `tool` when `Target` (an Apex class, or a trigger) changes and a class uses it. */
async function resultText(tool: string, kind: "class" | "trigger" = "trigger"): Promise<string> {
  const label = kind === "trigger" ? "ApexTrigger" : "ApexClass";
  const file =
    kind === "trigger"
      ? "force-app/main/default/triggers/Target.trigger"
      : "force-app/main/default/classes/Target.cls";
  const target = `${label}:Target`;
  fix.addNode({ qualifiedName: target, label, sourceHash: "v1" });
  fix.addNode({ qualifiedName: "ApexClass:Caller", label: "ApexClass" });
  fix.addEdge({
    srcQualifiedName: "ApexClass:Caller",
    dstQualifiedName: target,
    relType: REL_TYPES.CALLS,
  });
  if (tool === "test_gap_intelligence_from_git_diff")
    return (await callTool(tool, { org: fix.orgId, diff: `--- a/${file}\n+++ b/${file}\n@@\n` }))
      .markdown;
  if (tool === "what_broke") {
    const snap = fix.ctx.snapshotStore.createSnapshot(fix.orgId, "pre-sync", true);
    fix.addNode({ qualifiedName: target, label, sourceHash: "v2" });
    return (await callTool(tool, { org: fix.orgId, since: snap.id })).markdown;
  }
  writeFileSync(
    path.join(projectRoot, "sfdx-project.json"),
    JSON.stringify({ packageDirectories: [{ path: "force-app", default: true }] }),
  );
  const abs = path.join(projectRoot, file);
  mkdirSync(path.dirname(abs), { recursive: true });
  writeFileSync(
    abs,
    kind === "trigger"
      ? "trigger Target on Account (before insert) { Integer y; }"
      : "public class Target { Integer y; }",
  );
  return (await callTool(tool, { org: fix.orgId, project_root: projectRoot })).markdown;
}

describe("Batch Q2 caveats", () => {
  it.each(["test_gap_intelligence_from_git_diff", "wip_test_gap", "what_broke"])(
    "%s says in its result that trigger coverage is not modelled",
    async (tool) => {
      const text = await resultText(tool);
      expect(text).toMatch(/`IS_TEST_FOR` links test classes to classes only/);
      expect(text).toMatch(/trigger coverage via DML is not modelled/);
      expect(desc(tool)).not.toMatch(/not modelled/);
    },
  );

  // Cycle 3 T5 fix 1 (I1): the note shows only when a trigger is among the pieces.
  it.each(["test_gap_intelligence_from_git_diff", "wip_test_gap", "what_broke"])(
    "%s leaves the trigger-coverage note out when no trigger is involved",
    async (tool) => {
      const text = await resultText(tool, "class");
      expect(text).toMatch(/Target/);
      expect(text).not.toMatch(/IS_TEST_FOR/);
    },
  );

  // Cycle 2 T5 fix round 2: the references are in the text (an MCP caller never sees `data`).
  it("explain_code names the direct references; its result says what they leave out", async () => {
    expect(desc("explain_code")).toMatch(/direct references/);
    fix.addNode({ qualifiedName: "ApexTrigger:T", label: "ApexTrigger" });
    fix.addNode({ qualifiedName: "ApexClass:Svc", label: "ApexClass" });
    fix.addEdge({
      srcQualifiedName: "ApexTrigger:T",
      dstQualifiedName: "ApexClass:Svc",
      relType: REL_TYPES.CALLS,
    });
    const r = await callTool("explain_code", { org: fix.orgId, qname: "ApexTrigger:T" });
    expect(r.markdown).toMatch(/pseudo endpoints/);
  });

  // T5 review (Low 6 ruling): the result states what includeTests does, with no advice keyed to
  // how a question is worded (that advice came from reading a task key).
  it("governor_risk_check states the includeTests default without question-wording advice", async () => {
    const off = await callTool("governor_risk_check", { org: fix.orgId });
    expect(off.markdown).toMatch(/Test code is excluded unless `includeTests` is true\./);
    const on = await callTool("governor_risk_check", { org: fix.orgId, includeTests: true });
    expect(on.markdown).not.toMatch(/Test code is excluded unless/);
    for (const t of [desc("governor_risk_check"), off.markdown])
      expect(t).not.toMatch(/names a test class|asks about test code/);
  });
});
