import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parserRegistry } from "../../registry.js";
import { loadAllRules } from "../_loader.js";
import { loadUserRules } from "../_user-rules.js";

const rule = (type: string, extra = "") =>
  `type: ${type}\ncategory: Custom\ninput: xml-string\nroot: ${type}\napplies_when:\n  always: true\nnodes:\n  - label: ${type}\n    qname: "${type}:\${record.name}"\nedges: []\n${extra}`;

function dir(files: Record<string, string>): string {
  const d = mkdtempSync(path.join(tmpdir(), "user-rules-"));
  for (const [n, c] of Object.entries(files)) writeFileSync(path.join(d, n), c, "utf8");
  return d;
}

describe("user rule files (SFGRAPH_RULES_DIR)", () => {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  afterEach(() => {
    warn.mockClear();
    Reflect.deleteProperty(process.env, "SFGRAPH_RULES_DIR");
  });

  it("loads a valid rule for a new type and registers its parser", async () => {
    const d = dir({ "a.yml": rule("UserTypeOne") });
    const r = await loadUserRules(d);
    expect(r.loaded).toEqual(["a.yml"]);
    expect(r.skipped).toEqual([]);
    expect(parserRegistry.for("UserTypeOne")).toBeDefined();
    // idempotent: a second load is a quiet no-op, not a clash
    const again = await loadUserRules(d);
    expect(again.skipped).toEqual([]);
    expect(again.warnings).toEqual([]);
  });

  it("skips invalid YAML and schema-invalid files with a warning, never throws", async () => {
    const d = dir({
      "bad-yaml.yml": "type: [unclosed\n",
      "bad-schema.yml": "type: 123\nnot_valid: yes\n",
      "good.yml": rule("UserTypeTwo"),
      "_ignored.yml": "whatever: 1\n",
      "notes.txt": "not yaml",
    });
    const r = await loadUserRules(d);
    expect(r.loaded).toEqual(["good.yml"]);
    expect(r.skipped.map((s) => s.file).sort()).toEqual(["bad-schema.yml", "bad-yaml.yml"]);
    expect(warn).toHaveBeenCalledTimes(2);
    expect(parserRegistry.for("UserTypeTwo")).toBeDefined();
  });

  it("a missing directory is a warning, not a crash", async () => {
    const r = await loadUserRules(path.join(tmpdir(), "does-not-exist-sfgraph-rules"));
    expect(r.loaded).toEqual([]);
    expect(r.warnings[0]).toMatch(/cannot read/);
  });

  it("built-in rules win on a type-name clash unless override: true", async () => {
    await loadAllRules(); // registers the built-ins (idempotent)
    const builtIn = parserRegistry.for("CustomTab");
    expect(builtIn).toBeDefined();

    const clash = await loadUserRules(dir({ "tab.yml": rule("CustomTab") }));
    expect(clash.loaded).toEqual([]);
    expect(clash.skipped[0]?.reason).toMatch(/built-in/);
    expect(parserRegistry.for("CustomTab")).toBe(builtIn);

    const over = await loadUserRules(dir({ "tab.yml": rule("CustomTab", "override: true\n") }));
    expect(over.loaded).toEqual(["tab.yml"]);
    expect(over.overridden).toEqual(["tab.yml"]);
    expect(parserRegistry.for("CustomTab")).not.toBe(builtIn);
    // restore the built-in for the other tests in this file / process
    parserRegistry.replace(builtIn!);
  });

  it("two files for one type in the same directory: the first wins", async () => {
    const r = await loadUserRules(
      dir({ "a.yml": rule("UserTypeDup"), "b.yml": rule("UserTypeDup") }),
    );
    expect(r.loaded).toEqual(["a.yml"]);
    expect(r.skipped.map((s) => s.file)).toEqual(["b.yml"]);
  });

  it("loadAllRules reads SFGRAPH_RULES_DIR, and a rule-parsed member produces its node", async () => {
    process.env.SFGRAPH_RULES_DIR = dir({ "c.yml": rule("UserTypeThree") });
    const out = await loadAllRules();
    expect(out.user?.loaded).toEqual(["c.yml"]);
    const p = parserRegistry.for("UserTypeThree")!;
    const res = await p.parse({ name: "N1", xml: "<UserTypeThree><x>1</x></UserTypeThree>" }, {
      orgId: "o",
      parseTimestamp: new Date().toISOString(),
      namespace: null,
      sourceUri: "t",
    } as never);
    expect(res.nodes.map((n) => String(n.qualifiedName))).toEqual(["UserTypeThree:N1"]);
  });

  it("user rules can declare aliases; a built-in alias name clash is skipped without override", async () => {
    await loadAllRules();
    const planner = parserRegistry.for("GenAiPlannerBundle");
    expect(planner).toBeDefined();
    const r = await loadUserRules(
      dir({
        "x.yml": rule(
          "UserTypeAliased",
          "aliases:\n  - UserTypeAliasedV2\n  - GenAiPlannerBundle\n",
        ),
      }),
    );
    expect(r.loaded).toEqual(["x.yml"]);
    expect(parserRegistry.for("UserTypeAliasedV2")).toBeDefined();
    expect(parserRegistry.for("GenAiPlannerBundle")).toBe(planner);
    expect(r.warnings.some((w) => /alias "GenAiPlannerBundle".*built-in/.test(w))).toBe(true);
    const out = await parserRegistry
      .for("UserTypeAliasedV2")!
      .parse({ name: "N2", xml: "<UserTypeAliasedV2><x>1</x></UserTypeAliasedV2>" }, {
        orgId: "o",
        parseTimestamp: new Date().toISOString(),
        namespace: null,
        sourceUri: "t",
      } as never);
    expect(out.nodes.map((n) => String(n.qualifiedName))).toEqual(["UserTypeAliased:N2"]);
  });

  it("dryRun validates without registering", async () => {
    const r = await loadUserRules(dir({ "d.yml": rule("UserTypeDry") }), { dryRun: true });
    expect(r.loaded).toEqual(["d.yml"]);
    expect(parserRegistry.for("UserTypeDry")).toBeUndefined();
  });
});
