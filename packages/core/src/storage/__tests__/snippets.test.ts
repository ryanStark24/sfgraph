import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { asOrgId, asQualifiedName, asSha256 } from "@ryanstark24/sfgraph-shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { SnippetRecord } from "../interfaces.js";
import { SqliteGraphStore } from "../sqlite/graph-store.js";

let workDir: string;
let store: SqliteGraphStore;

beforeEach(async () => {
  workDir = mkdtempSync(path.join(tmpdir(), "sfg-snip-"));
  store = new SqliteGraphStore({
    dbPath: path.join(workDir, "g.sqlite"),
    backupDir: path.join(workDir, "bkp"),
  });
  await store.init();
});

afterEach(async () => {
  await store.close();
  rmSync(workDir, { recursive: true, force: true });
});

function rec(qname: string, body: string, hash: string): SnippetRecord {
  return {
    orgId: asOrgId("org1"),
    qualifiedName: asQualifiedName(qname),
    sourceFormat: "apex",
    sourceText: body,
    sourceHash: asSha256(hash),
    startLine: 1,
    endLine: body.split("\n").length,
  };
}

describe("snippet store", () => {
  it("first upsert inserts", () => {
    const r = store.upsertSnippet(rec("ApexMethod:Foo.bar(0)", "return 1;", "h1"));
    expect(r).toEqual({ inserted: true, updated: false, unchanged: false });
  });

  it("second upsert with same hash returns unchanged", () => {
    const s = rec("ApexMethod:Foo.bar(0)", "return 1;", "h1");
    store.upsertSnippet(s);
    const r = store.upsertSnippet(s);
    expect(r).toEqual({ inserted: false, updated: false, unchanged: true });
  });

  it("modified text returns updated and clears prior explanation", () => {
    const s1 = rec("ApexMethod:Foo.bar(0)", "return 1;", "h1");
    store.upsertSnippet(s1);
    store.updateSnippetExplanation(s1.orgId, s1.qualifiedName, "older expl", 123);
    const r = store.upsertSnippet(rec("ApexMethod:Foo.bar(0)", "return 2;", "h2"));
    expect(r).toEqual({ inserted: false, updated: true, unchanged: false });
    const got = store.getSnippet(s1.orgId, s1.qualifiedName);
    expect(got?.sourceText).toBe("return 2;");
    expect(got?.llmExplanation).toBeUndefined();
  });

  it("getSnippet round-trips fields", () => {
    const s = rec("ApexMethod:Foo.bar(0)", "x;\ny;", "h3");
    store.upsertSnippet(s);
    const got = store.getSnippet(s.orgId, s.qualifiedName);
    expect(got).not.toBeNull();
    expect(got?.sourceFormat).toBe("apex");
    expect(got?.sourceText).toBe("x;\ny;");
    expect(got?.startLine).toBe(1);
    expect(got?.endLine).toBe(2);
    expect(got?.sourceHash).toBe("h3");
  });

  it("updateSnippetExplanation flips the column", () => {
    const s = rec("ApexMethod:Foo.bar(0)", "return 1;", "h4");
    store.upsertSnippet(s);
    const ok = store.updateSnippetExplanation(s.orgId, s.qualifiedName, "does the thing", 777);
    expect(ok).toBe(true);
    const got = store.getSnippet(s.orgId, s.qualifiedName);
    expect(got?.llmExplanation).toBe("does the thing");
    expect(got?.explainedAt).toBe(777);
  });

  it("listSnippetsMissingExplanation filters correctly", () => {
    const a = rec("ApexMethod:A.m(0)", "a", "ha");
    const b = rec("ApexMethod:B.m(0)", "b", "hb");
    const c = rec("ApexMethod:C.m(0)", "c", "hc");
    store.upsertSnippet(a);
    store.upsertSnippet(b);
    store.upsertSnippet(c);
    store.updateSnippetExplanation(b.orgId, b.qualifiedName, "expl", 1);
    const missing = store.listSnippetsMissingExplanation(asOrgId("org1"));
    const names = missing.map((m) => m.qualifiedName).sort();
    expect(names).toEqual(["ApexMethod:A.m(0)", "ApexMethod:C.m(0)"]);
    const limited = store.listSnippetsMissingExplanation(asOrgId("org1"), 1);
    expect(limited).toHaveLength(1);
  });
});
