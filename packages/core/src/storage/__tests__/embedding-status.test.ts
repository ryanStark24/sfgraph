import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { asOrgId, asQualifiedName } from "@ryanstark24/sfgraph-shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SqliteGraphStore } from "../sqlite/graph-store.js";

/**
 * Task 11a: embeddings finish after "graph ready", so the store records
 * whether an org's vectors are still being written. find_similar reads it to
 * fall back to text search, and the next ingest reads it to backfill vectors
 * left pending by `--no-wait-embeddings` or a crash.
 */

let dir: string;
let store: SqliteGraphStore;
const org = asOrgId("00DEMBSTATUS00000A");

beforeEach(async () => {
  dir = mkdtempSync(path.join(tmpdir(), "sfg-embstatus-"));
  store = new SqliteGraphStore({
    dbPath: path.join(dir, "g.sqlite"),
    backupDir: path.join(dir, "bk"),
  });
  await store.init();
  store.upsertOrg({
    id: org,
    alias: "a",
    instanceUrl: "https://x",
    apiVersion: "60.0",
    createdAt: 1,
  });
});
afterEach(async () => {
  await store.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("embedding status", () => {
  it("defaults to not pending, and round-trips the flag", () => {
    expect(store.getEmbeddingStatus(org)).toEqual({ pending: false, total: 0 });
    store.setEmbeddingsPending(org, true);
    expect(store.getEmbeddingStatus(org)?.pending).toBe(true);
    store.setEmbeddingsPending(org, false);
    expect(store.getEmbeddingStatus(org)?.pending).toBe(false);
  });

  it("total is the number of FTS docs (one per embedded text) for the org", () => {
    store.upsertNodeFts(org, asQualifiedName("ApexClass:A"), "ApexClass", "class a");
    store.upsertNodeFts(org, asQualifiedName("ApexClass:B"), "ApexClass", "class b");
    store.upsertNodeFts(org, asQualifiedName("ApexClass:A"), "ApexClass", "class a v2");
    store.upsertNodeFts(asOrgId("00DOTHER000000000A"), asQualifiedName("X:Y"), "X", "other");
    expect(store.getEmbeddingStatus(org)?.total).toBe(2);
  });

  it("returns null for an unknown org", () => {
    expect(store.getEmbeddingStatus(asOrgId("00DNOPE0000000000A"))).toBeNull();
  });

  it("listFtsDocs yields each org doc's qname, label and exact body", () => {
    store.upsertNodeFts(org, asQualifiedName("ApexClass:A"), "ApexClass", "old");
    store.upsertNodeFts(org, asQualifiedName("ApexClass:A"), "ApexClass", "class a\nbody");
    store.upsertNodeFts(org, asQualifiedName("Flow:F"), "Flow", "flow f");
    const docs = [...store.listFtsDocs(org)].sort((x, y) => x.qname.localeCompare(y.qname));
    expect(docs).toEqual([
      { qname: "ApexClass:A", label: "ApexClass", body: "class a\nbody" },
      { qname: "Flow:F", label: "Flow", body: "flow f" },
    ]);
  });

  it("m-4: listFtsDocs streams in pages, and the store stays writable between pages", () => {
    for (let i = 0; i < 7; i++) {
      store.upsertNodeFts(org, asQualifiedName(`ApexClass:C${i}`), "ApexClass", `body ${i}`);
    }
    const seen: string[] = [];
    let first = true;
    for (const d of store.listFtsDocs(org, 3)) {
      seen.push(d.qname);
      if (first) {
        // A write mid-iteration (as forced embedding dispatch does) must not
        // hit "connection busy" or disturb the remaining pages.
        store.setEmbeddingsPending(org, true);
        // Streaming (not a snapshot of every row up front): a doc added
        // after the first page was read shows up in a later page.
        store.upsertNodeFts(org, asQualifiedName("ApexClass:Late"), "ApexClass", "late");
        first = false;
      }
    }
    expect(seen).toEqual([
      ...Array.from({ length: 7 }, (_, i) => `ApexClass:C${i}`),
      "ApexClass:Late",
    ]);
  });
});
