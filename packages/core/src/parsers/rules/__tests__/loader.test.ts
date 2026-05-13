import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadAllRules } from "../_loader.js";

describe("rule loader", () => {
  it("loads at least 20 parsers from the canonical rules directory", async () => {
    const out = await loadAllRules({ skipRegister: true });
    expect(out.loaded.length).toBeGreaterThanOrEqual(20);
    expect(out.parsers.length).toBe(out.loaded.length);
  });

  it("throws a clear error for an invalid rule file", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "rules-bad-"));
    writeFileSync(path.join(dir, "bad.yml"), "type: 123\nnot_valid: yes\n", "utf8");
    await expect(loadAllRules({ dir, skipRegister: true })).rejects.toThrow(/Invalid rule file/);
  });

  it("rejects duplicate type across two rule files", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "rules-dup-"));
    const body =
      "type: Dupe\ncategory: Profile\ninput: object\napplies_when:\n  always: true\nnodes: []\nedges: []\n";
    writeFileSync(path.join(dir, "a.yml"), body, "utf8");
    writeFileSync(path.join(dir, "b.yml"), body, "utf8");
    await expect(loadAllRules({ dir, skipRegister: true })).rejects.toThrow(
      /Duplicate parser type/,
    );
  });

  it("skips files prefixed with _", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "rules-skip-"));
    writeFileSync(path.join(dir, "_engine.yml"), "this: should\nbe: skipped\n", "utf8");
    const out = await loadAllRules({ dir, skipRegister: true });
    expect(out.loaded).toEqual([]);
  });
});
