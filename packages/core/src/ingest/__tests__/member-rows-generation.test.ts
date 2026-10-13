import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { APEX_NODE_HASH_SALT } from "../../parsers/apex/class.js";
import { HASH_SALTS } from "../../parsers/hash-salts.js";
import { LWC_NODE_HASH_SALT } from "../../parsers/lwc/bundle.js";
import { memberRowsGeneration, saltsHash } from "../member-rows.js";

// Cycle 3 final review I-1: a salt bump inside one core version must change the member-row
// generation, so a delta rebuilds instead of keeping old output for unchanged members.
describe("memberRowsGeneration", () => {
  it("is core@<version>+<short hash of the salts>", () => {
    expect(memberRowsGeneration()).toMatch(/^core@\d+\.\d+\.\d+[^+]*\+[0-9a-f]{12}$/);
    expect(memberRowsGeneration()).toBe(memberRowsGeneration(HASH_SALTS));
    expect(memberRowsGeneration().endsWith(`+${saltsHash()}`)).toBe(true);
  });

  it("changes when any salt changes", () => {
    const bumped = HASH_SALTS.map((s) => (s === APEX_NODE_HASH_SALT ? `${s}-next` : s));
    expect(memberRowsGeneration(bumped)).not.toBe(memberRowsGeneration());
    const base = memberRowsGeneration().split("+")[0];
    expect(memberRowsGeneration(bumped).split("+")[0]).toBe(base);
  });

  it("holds every exported parser salt", () => {
    expect(HASH_SALTS).toContain(APEX_NODE_HASH_SALT);
    expect(HASH_SALTS).toContain(LWC_NODE_HASH_SALT);
    expect(new Set(HASH_SALTS).size).toBe(HASH_SALTS.length);
  });

  it("no salt is declared outside parsers/hash-salts.ts", () => {
    const src = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
    const hits: string[] = [];
    for (const f of readdirSync(src, { recursive: true }) as string[]) {
      if (!f.endsWith(".ts") || f.includes("__tests__") || f.endsWith("hash-salts.ts")) continue;
      if (/const [A-Z_]+_HASH_SALT\s*=/.test(readFileSync(path.join(src, f), "utf8"))) hits.push(f);
    }
    expect(hits).toEqual([]);
  });
});

describe("final review core M-4: clearMemberRows is one transaction", () => {
  it("a failure on the generation delete keeps the member rows", async () => {
    const { SqliteGraphStore } = await import("../../storage/sqlite/graph-store.js");
    const { asOrgId } = await import("@ryanstark24/sfgraph-shared");
    const g = new SqliteGraphStore({ dbPath: ":memory:" });
    await g.init();
    try {
      const org = asOrgId("00DM4");
      g.replaceMemberRows(org, [{ key: "k", fingerprint: "f", hash: "h", owned: [] }], "core@x");
      g.db.exec(`CREATE TRIGGER no_gen_delete BEFORE DELETE ON _sfgraph_member_generation
                 BEGIN SELECT RAISE(ABORT, 'blocked'); END`);
      expect(() => g.clearMemberRows(org)).toThrow(/blocked/);
      expect(g.listMemberRows(org)).toHaveLength(1);
      expect(g.getMemberRowsGeneration(org)).toBe("core@x");
    } finally {
      await g.close();
    }
  });
});
