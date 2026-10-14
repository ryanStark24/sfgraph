import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  REL_TYPES,
  SqliteGraphStore,
  SqliteSnapshotStore,
  type VectorStore,
} from "@ryanstark24/sfgraph-core";
import { asOrgId, asQualifiedName, asSha256 } from "@ryanstark24/sfgraph-shared";
import { afterEach, describe, expect, it, vi } from "vitest";

// Text mode embeds the query; a fixed vector stands in for the model.
vi.mock("@ryanstark24/sfgraph-core", async (importOriginal) => {
  const real = await importOriginal<Record<string, unknown>>();
  const v = new Float32Array(384);
  v[0] = 1;
  return { ...real, embedSingle: async () => v };
});
import { setToolContextFactory } from "../../context.js";
import { estimate, minhash, nearCopies, shingles } from "../_near_copies.js";
import { DATA_LABEL_FLOOR, RELATIVE_CUTOFF, applyCutoffs } from "../find_similar.js";
import { callTool } from "./_runner.js";

// Cycle 3 C4: near-copy grouping (display only) and the per-kind floor + relative cutoff.

const ORG = "00DFINDSIMC4000XYZ";
let workDir: string;
let graphStore: SqliteGraphStore;

/** Cosine similarity s -> L2 distance of unit vectors (the tool maps back with 1 - d²/2). */
const dist = (s: number) => Math.sqrt(2 * (1 - s));

async function setup(results: Array<{ qname: string; label: string; sim: number }>) {
  workDir = mkdtempSync(path.join(tmpdir(), "sfg-c4-sim-"));
  const dbPath = path.join(workDir, "g.sqlite");
  graphStore = new SqliteGraphStore({ dbPath, backupDir: path.join(workDir, "bkp") });
  await graphStore.init();
  const snapshotStore = new SqliteSnapshotStore({
    dbPath,
    db: (graphStore as unknown as { db: never }).db,
    skipMigrations: true,
  });
  await snapshotStore.init();
  const focal = new Float32Array(384);
  focal[0] = 1;
  const vectors = new Map([[asQualifiedName("ApexClass:Focal"), focal]]);
  const vectorStore = {
    init: async () => {},
    close: async () => {},
    countNodeVectors: () => 1,
    getNodeVector: (_o: unknown, q: string) => vectors.get(q as never) ?? null,
    searchNodes: () =>
      results.map((r) => ({
        qname: asQualifiedName(r.qname),
        label: r.label,
        distance: dist(r.sim),
      })),
  } as unknown as VectorStore;
  const orgId = asOrgId(ORG);
  for (const q of ["ApexClass:Focal", ...results.map((r) => r.qname)]) {
    graphStore.mergeNodes([
      {
        orgId,
        qualifiedName: asQualifiedName(q),
        label: q.slice(0, q.indexOf(":")),
        attributes: {},
        sourceHash: asSha256(`h-${q}`),
        firstSeenAt: 1,
        lastSeenAt: 1,
        lastModifiedAt: 1,
      },
    ]);
  }
  setToolContextFactory(async () => ({ graphStore, snapshotStore, orgId, vectorStore }));
}
function snippet(q: string, text: string) {
  graphStore.upsertSnippet({
    orgId: asOrgId(ORG),
    qualifiedName: asQualifiedName(q),
    sourceFormat: "apex",
    sourceText: text,
    sourceHash: asSha256(`s-${q}`),
    startLine: 1,
    endLine: 1,
  });
}

afterEach(async () => {
  setToolContextFactory(null);
  await graphStore?.close();
  if (workDir) rmSync(workDir, { recursive: true, force: true });
});

const BODY =
  "global class Batch implements Database.Batchable<SObject> { global Database.QueryLocator start(Database.BatchableContext bc) { return Database.getQueryLocator('SELECT Id, Speed__c FROM Quote WHERE Speed__c != null'); } global void execute(Database.BatchableContext bc, List<Quote> scope) { for (Quote q : scope) { q.Speed__c = remap(q.Speed__c); } update scope; } }";

describe("near-copy fingerprints", () => {
  it("identical text has estimate 1, unrelated text near 0", () => {
    const a = minhash(shingles(BODY));
    expect(estimate(a, minhash(shingles(BODY)))).toBe(1);
    const b = minhash(
      shingles(
        "public with sharing class Mailer { void send(String to) { Messaging.sendEmail(new List<Messaging.SingleEmailMessage>{ build(to) }); } }",
      ),
    );
    expect(estimate(a, b)).toBeLessThan(0.2);
  });

  it("groups same-kind copies under the first item, never across kinds or short text", () => {
    const copy = BODY.replace(/Quote/g, "Opportunity");
    const m = nearCopies([
      { id: "A", kind: "ApexClass", text: BODY },
      { id: "B", kind: "ApexClass", text: `${BODY} ` },
      { id: "C", kind: "Flow", text: BODY },
      { id: "D", kind: "ApexClass", text: "short name only" },
      { id: "E", kind: "ApexClass", text: "short name only" },
      { id: "F", kind: "ApexClass", text: copy },
    ]);
    expect(m.get("B")).toBe("A");
    expect(m.has("A")).toBe(false);
    expect(m.has("C")).toBe(false); // other kind
    expect(m.has("D") || m.has("E")).toBe(false); // too short to call copies
    expect(m.has("F")).toBe(false); // object renamed in 8 places: below 0.8
  });
});

describe("cutoffs", () => {
  const hit = (
    qname: string,
    label: string,
    similarity: number | null,
    via: "vector" | "keyword" | "both",
  ) => ({
    qname,
    label,
    similarity,
    distance: null,
    via,
    rrf: 0,
  });
  it("keeps name matches and the top hit; cuts weak data rows and weak meaning-only rows", () => {
    const { kept, cut } = applyCutoffs([
      hit("ApexClass:Top", "ApexClass", 0.6, "both"),
      hit("CustomField:A.F__c", "CustomField", DATA_LABEL_FLOOR - 0.01, "both"),
      hit("CustomField:A.G__c", "CustomField", null, "keyword"),
      hit("ApexClass:Weak", "ApexClass", RELATIVE_CUTOFF * 0.6 - 0.01, "vector"),
      hit("ApexClass:WeakButNamed", "ApexClass", 0.42, "both"),
      hit("Flow:Ok", "Flow", 0.55, "vector"),
    ]);
    expect(kept.map((h) => h.qname)).toEqual([
      "ApexClass:Top",
      "CustomField:A.G__c",
      "ApexClass:WeakButNamed",
      "Flow:Ok",
    ]);
    expect(cut).toBe(2);
  });

  it("the tool reports the cut, keeps data rows above the floor, and min_similarity 0 turns cuts off", async () => {
    await setup([
      { qname: "ApexClass:Close", label: "ApexClass", sim: 0.7 },
      { qname: "ApexClass:Far", label: "ApexClass", sim: 0.5 },
      { qname: "CustomObject:Obj__c", label: "CustomObject", sim: 0.62 },
    ]);
    const r = await callTool("find_similar", { org: ORG, text: "close match" });
    const d = r.data as { hits: Array<{ qname: string }>; cutByCutoff: number };
    expect(d.hits.map((h) => h.qname)).toEqual(["ApexClass:Close", "CustomObject:Obj__c"]);
    expect(d.cutByCutoff).toBe(1);
    expect(r.markdown).toMatch(/1 weak match was left out/);
    const all = await callTool("find_similar", {
      org: ORG,
      text: "close match",
      min_similarity: 0,
    });
    expect((all.data as { hits: unknown[] }).hits).toHaveLength(3);
    // A focal piece's neighbours are not cut (the cutoffs were chosen on text searches).
    const byPiece = await callTool("find_similar", { org: ORG, qname: "ApexClass:Focal" });
    expect(byPiece.data).not.toHaveProperty("cutByCutoff");
    expect((byPiece.data as { hits: unknown[] }).hits).toHaveLength(3);
  });
});

describe("near-copies in the report", () => {
  it("lists a copy under its representative but keeps every row in data.hits", async () => {
    await setup([
      { qname: "ApexClass:BatchQuote", label: "ApexClass", sim: 0.7 },
      { qname: "ApexClass:BatchOpp", label: "ApexClass", sim: 0.69 },
      { qname: "ApexClass:Other", label: "ApexClass", sim: 0.68 },
    ]);
    // Classes are fingerprinted by their methods' source.
    for (const c of ["BatchQuote", "BatchOpp"]) {
      graphStore.mergeNodes([
        {
          orgId: asOrgId(ORG),
          qualifiedName: asQualifiedName(`ApexMethod:${c}.execute(2)`),
          label: "ApexMethod",
          attributes: {},
          sourceHash: asSha256(`m-${c}`),
          firstSeenAt: 1,
          lastSeenAt: 1,
          lastModifiedAt: 1,
        },
      ]);
      graphStore.mergeEdges([
        {
          orgId: asOrgId(ORG),
          srcQualifiedName: asQualifiedName(`ApexClass:${c}`),
          dstQualifiedName: asQualifiedName(`ApexMethod:${c}.execute(2)`),
          relType: REL_TYPES.CONTAINS_METHOD,
          attributes: {},
          firstSeenAt: 1,
          lastSeenAt: 1,
        } as never,
      ]);
      snippet(`ApexMethod:${c}.execute(2)`, BODY);
    }
    snippet(
      "ApexClass:Other",
      "public class Other { void send(String to) { Messaging.sendEmail(new List<Messaging.SingleEmailMessage>{ build(to) }); } }",
    );
    const r = await callTool("find_similar", { org: ORG, qname: "ApexClass:Focal" });
    const d = r.data as { hits: Array<{ qname: string; nearCopyOf?: string }> };
    expect(d.hits.map((h) => h.qname)).toEqual([
      "ApexClass:BatchQuote",
      "ApexClass:BatchOpp",
      "ApexClass:Other",
    ]);
    expect(d.hits[1]?.nearCopyOf).toBe("ApexClass:BatchQuote");
    expect(d.hits[2]?.nearCopyOf).toBeUndefined();
    expect(r.markdown).toMatch(/1 near-copy \(almost the same code\): `BatchOpp`/);
    expect(r.markdown).toMatch(/1 of them is a near-copy of another match, listed under it/);
    expect(r.markdown).toMatch(/near-copy of #1/);
    expect(r.markdown).not.toMatch(/^- `BatchOpp`/m);
  });
});
