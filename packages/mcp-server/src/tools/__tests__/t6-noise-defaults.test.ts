import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { SqliteGraphStore, SqliteSnapshotStore, type VectorStore } from "@ryanstark24/sfgraph-core";
import type { NodeFact } from "@ryanstark24/sfgraph-core";
import { asOrgId, asQualifiedName, asSha256 } from "@ryanstark24/sfgraph-shared";
import { afterEach, describe, expect, it } from "vitest";
import { setToolContextFactory } from "../../context.js";
import { type Fixture, createFixture } from "./_fixture.js";
import { section } from "./_jargon.js";
import { callTool } from "./_runner.js";

// Cycle 3 T6: quieter defaults. cross_org_diff hides managed-package and standard items found in
// one org only, governor_risk_check hides spots below `min_severity`, find_similar hides matches
// below `min_similarity`. Every hidden count is stated in words and in `data`, and when everything
// is hidden the report says so instead of claiming there is nothing.

const LABEL_NAME = /\b[A-Z][A-Za-z]+:[A-Za-z_]/;

describe("cross_org_diff: managed and standard items in one org only are hidden by default", () => {
  let dir: string;
  let stores: SqliteGraphStore[] = [];
  afterEach(async () => {
    setToolContextFactory(null);
    for (const s of stores) await s.close();
    stores = [];
    rmSync(dir, { recursive: true, force: true });
  });

  async function twoOrgs(a: Array<[string, string, Record<string, unknown>?]>, b: typeof a) {
    dir = mkdtempSync(path.join(tmpdir(), "sfg-t6-co-"));
    const open = async (name: string, org: string, rows: typeof a) => {
      const g = new SqliteGraphStore({
        dbPath: path.join(dir, `${name}.sqlite`),
        backupDir: path.join(dir, `bkp-${name}`),
      });
      await g.init();
      const snap = new SqliteSnapshotStore({
        dbPath: path.join(dir, `${name}.sqlite`),
        db: (g as unknown as { db: never }).db,
        skipMigrations: true,
      });
      await snap.init();
      g.mergeNodes(
        rows.map(
          ([qn, hash, attributes]): NodeFact => ({
            orgId: asOrgId(org),
            qualifiedName: asQualifiedName(qn),
            label: qn.slice(0, qn.indexOf(":")),
            attributes: attributes ?? {},
            sourceHash: asSha256(hash),
            firstSeenAt: 1,
            lastSeenAt: 1,
            lastModifiedAt: 1,
          }),
        ),
      );
      stores.push(g);
      return { graphStore: g, snapshotStore: snap, orgId: asOrgId(org) };
    };
    const ca = await open("a", "repoOrg", a);
    const cb = await open("b", "liveOrg", b);
    setToolContextFactory(async ({ orgId }) => (orgId === "repoOrg" ? ca : cb));
  }

  const A: Array<[string, string, Record<string, unknown>?]> = [
    ["CustomObject:Invoice__c", "i1"],
    ["CustomObject:Account", "acc1"],
    ["CustomObject:Activity", "act"],
    ["CustomObject:acme__Doc__c", "d1"],
  ];
  const B: typeof A = [
    ["CustomObject:Account", "acc2"],
    ["CustomObject:acme__Doc__c", "d2"],
    ["CustomObject:acme__Rate__mdt", "r"],
    ["CustomObject:AccountBrand", "ab"],
    ["CustomObject:Shipment__c", "s"],
    ["ApexClass:Widget", "w", { modifiers: [], isTest: false }],
  ];

  it("hides them, keeps changed ones, and states both counts in words and in data", async () => {
    await twoOrgs(A, B);
    const r = await callTool("cross_org_diff", { org_a: "repoOrg", org_b: "liveOrg" });
    const d = r.data as {
      onlyInA: string[];
      onlyInB: string[];
      changed: string[];
      hidden: { managed: number; standard: number };
    };
    expect(d.onlyInA).toEqual(["CustomObject:Invoice__c"]);
    expect(d.onlyInB).toEqual(["CustomObject:Shipment__c"]);
    expect([...d.changed].sort()).toEqual(["CustomObject:Account", "CustomObject:acme__Doc__c"]);
    expect(d.hidden).toEqual({ managed: 2, standard: 2 });
    const inShort = section(r.markdown, "In short") ?? "";
    expect(inShort).toContain("2 managed-package items and 2 standard Salesforce items");
    expect(inShort).toContain("`include_managed: true`");
    expect(inShort).toContain("`include_standard: true`");
    expect(inShort.replace(/`[^`]*`/g, "")).not.toMatch(LABEL_NAME);
  });

  it("when every difference is hidden, In short says so instead of 'no differences'", async () => {
    await twoOrgs(
      [["CustomObject:Invoice__c", "i1"]],
      [
        ["CustomObject:Invoice__c", "i1"],
        ["CustomObject:acme__Rate__mdt", "r"],
        ["CustomObject:acme__Doc__c", "d"],
        ["CustomObject:AccountBrand", "ab"],
      ],
    );
    const r = await callTool("cross_org_diff", { org_a: "repoOrg", org_b: "liveOrg" });
    const inShort = section(r.markdown, "In short") ?? "";
    expect(inShort).not.toContain("No differences found");
    expect(inShort).toContain(
      "No differences are shown between `repoOrg` and `liveOrg`: the only differences are 2 managed-package items and 1 standard Salesforce item found in one org only, hidden by default, though they count if the question is what exists in one org but not the other; call again with `include_managed: true` or `include_standard: true` to see them.",
    );
    expect(inShort.match(/hidden by default|not shown/g)).toHaveLength(1);
    expect(r.summary).toContain("hidden:3");
  });

  it("with nothing hidden and nothing different, it says no differences and mentions no hiding", async () => {
    await twoOrgs([["CustomObject:Invoice__c", "i1"]], [["CustomObject:Invoice__c", "i1"]]);
    const r = await callTool("cross_org_diff", { org_a: "repoOrg", org_b: "liveOrg" });
    const inShort = section(r.markdown, "In short") ?? "";
    expect(inShort).toContain("No differences found between `repoOrg` and `liveOrg`");
    expect(inShort).not.toMatch(/hidden|not shown/);
    expect(r.summary).not.toContain("hidden");
  });

  it("include_managed and include_standard list them again", async () => {
    await twoOrgs(A, B);
    const r = await callTool("cross_org_diff", {
      org_a: "repoOrg",
      org_b: "liveOrg",
      include_managed: true,
      include_standard: true,
    });
    const d = r.data as { onlyInA: string[]; onlyInB: string[]; hidden: object };
    expect(d.onlyInA).toHaveLength(2);
    expect(d.onlyInB).toHaveLength(4);
    expect(d.hidden).toEqual({ managed: 0, standard: 0 });
    expect(section(r.markdown, "In short")).not.toContain("not shown");
  });
});

describe("governor_risk_check: min_severity (default medium) and spots grouped by component", () => {
  let fix: Fixture;
  afterEach(async () => {
    await fix.cleanup();
  });

  async function setup(withLoops = true): Promise<void> {
    fix = await createFixture();
    const loop = (m: string, rel: string, dst: string) => {
      fix.addNode({ qualifiedName: m, label: "ApexMethod" });
      fix.addEdge({
        srcQualifiedName: m,
        dstQualifiedName: dst,
        relType: rel,
        attributes: { inLoop: true, query: `[SELECT Id FROM ${dst.slice(dst.indexOf(":") + 1)}]` },
      });
    };
    if (withLoops) {
      loop("ApexMethod:Alpha.load(0)", "EXECUTES_SOQL", "CustomObject:Invoice__c");
      loop("ApexMethod:Beta.read(0)", "EXECUTES_SOQL", "CustomObject:Invoice__c");
      loop("ApexMethod:Alpha.save(0)", "EXECUTES_DML", "CustomObject:Invoice__c");
    }
    // A medium-risk spot only the cache holds (an unbounded query from a body scan).
    const db = (fix.ctx.graphStore as unknown as { db: never }).db as {
      prepare: (s: string) => { run: (...a: unknown[]) => void };
    };
    (fix.ctx as { db?: unknown }).db = db;
    fix.ctx.graphStore.upsertOrg({
      id: fix.orgId,
      alias: "t6",
      instanceUrl: "https://example.my.salesforce.com",
      apiVersion: "62.0",
      createdAt: 1,
    });
    fix.ctx.graphStore.markSyncComplete(fix.orgId, new Date(1000).toISOString());
    db.prepare(
      "INSERT INTO _sfgraph_governor_risks (org_id, qualified_name, risk_type, evidence, line, computed_at) VALUES (?, ?, ?, ?, ?, ?)",
    ).run(
      String(fix.orgId),
      "ApexClass:Gamma",
      "unbounded_query",
      "SELECT Id FROM Invoice__c",
      -1,
      2000,
    );
  }

  it("the default keeps high and medium spots; min_severity high hides the medium one and says so", async () => {
    await setup();
    const all = await callTool("governor_risk_check", { org: fix.orgId });
    const da = all.data as { total: number; minSeverity: string; hiddenBelowSeverity: number };
    expect(da.minSeverity).toBe("medium");
    expect(da.total).toBe(4);
    expect(da.hiddenBelowSeverity).toBe(0);
    expect(section(all.markdown, "In short")).not.toContain("not shown");

    const high = await callTool("governor_risk_check", { org: fix.orgId, min_severity: "high" });
    const dh = high.data as {
      total: number;
      hiddenBelowSeverity: number;
      risks: Array<{ qualifiedName: string }>;
    };
    expect(dh.total).toBe(3);
    expect(dh.hiddenBelowSeverity).toBe(1);
    expect(dh.risks.map((x) => x.qualifiedName)).not.toContain("ApexClass:Gamma");
    const inShort = section(high.markdown, "In short") ?? "";
    expect(inShort).toContain("1 medium-risk spot is not shown");
    expect(inShort).toContain('`min_severity: "medium"`');
    expect(inShort.replace(/`[^`]*`/g, "")).not.toMatch(LABEL_NAME);
  });

  it("when every spot is below min_severity, In short and the summary say they are hidden", async () => {
    await setup(false);
    const r = await callTool("governor_risk_check", { org: fix.orgId, min_severity: "high" });
    expect((r.data as { hiddenBelowSeverity: number }).hiddenBelowSeverity).toBe(1);
    const inShort = section(r.markdown, "In short") ?? "";
    expect(inShort).not.toContain("No spots found");
    expect(inShort).toContain(
      'No spots are shown: the only spot found is 1 medium-risk spot, below `min_severity: "high"`; set `min_severity: "medium"` to see it.',
    );
    expect(inShort.match(/not shown|to see it/g)).toHaveLength(1);
    expect(r.summary).toBe("no risks at or above high (1 hidden below min_severity)");
  });

  it("with no spots at all, it says none were found and mentions no hiding", async () => {
    fix = await createFixture();
    const r = await callTool("governor_risk_check", { org: fix.orgId });
    expect(r.summary).toBe("no risks detected");
    const inShort = section(r.markdown, "In short") ?? "";
    expect(inShort).toContain("No spots found");
    expect(inShort).not.toMatch(/not shown|hidden/);
  });

  it("accepts low and rejects an unknown level", async () => {
    await setup();
    const low = await callTool("governor_risk_check", { org: fix.orgId, min_severity: "low" });
    expect((low.data as { total: number }).total).toBe(4);
    await expect(
      callTool("governor_risk_check", { org: fix.orgId, min_severity: "critical" }),
    ).rejects.toThrow();
  });

  it("technical details list the spots grouped by class or trigger, in priority order", async () => {
    await setup();
    const r = await callTool("governor_risk_check", { org: fix.orgId });
    // priority order is Alpha.load, Beta.read (SOQL), Alpha.save (DML): grouped, Alpha's two come first
    const details = section(r.markdown, "Technical details") ?? "";
    const at = (s: string) => details.indexOf(s);
    expect(at("#### `ApexClass:Alpha`")).toBeGreaterThanOrEqual(0);
    expect(at("ApexMethod:Alpha.load(0)")).toBeLessThan(at("ApexMethod:Alpha.save(0)"));
    expect(at("ApexMethod:Alpha.save(0)")).toBeLessThan(at("#### `ApexClass:Beta`"));
    expect(at("#### `ApexClass:Beta`")).toBeLessThan(at("ApexMethod:Beta.read(0)"));
    // data keeps the documented priority order
    const q = (r.data as { risks: Array<{ qualifiedName: string }> }).risks.map(
      (x) => x.qualifiedName,
    );
    expect(q.slice(0, 3)).toEqual([
      "ApexMethod:Alpha.load(0)",
      "ApexMethod:Beta.read(0)",
      "ApexMethod:Alpha.save(0)",
    ]);
  });
});

describe("find_similar: min_similarity hides weak matches; similar names stay separate rows", () => {
  let dir: string;
  let g: SqliteGraphStore;
  const ORG = "simOrg";
  afterEach(async () => {
    setToolContextFactory(null);
    await g.close();
    rmSync(dir, { recursive: true, force: true });
  });

  /** Unit vector at `sim` cosine from the focal [1, 0]. */
  const at = (sim: number) => Math.sqrt(2 * (1 - sim));

  async function setup(): Promise<void> {
    dir = mkdtempSync(path.join(tmpdir(), "sfg-t6-fs-"));
    const dbPath = path.join(dir, "g.sqlite");
    g = new SqliteGraphStore({ dbPath, backupDir: path.join(dir, "bkp") });
    await g.init();
    const snap = new SqliteSnapshotStore({
      dbPath,
      db: (g as unknown as { db: never }).db,
      skipMigrations: true,
    });
    await snap.init();
    const node = (qn: string): NodeFact => ({
      orgId: asOrgId(ORG),
      qualifiedName: asQualifiedName(qn),
      label: qn.slice(0, qn.indexOf(":")),
      attributes: {},
      sourceHash: asSha256(`h-${qn}`),
      firstSeenAt: 1,
      lastSeenAt: 1,
      lastModifiedAt: 1,
    });
    const names = [
      "ApexClass:Focal",
      "ApexClass:InvoiceBatch",
      "ApexClass:InvoiceBatchRetry",
      "ApexClass:InvoiceScheduler",
      "ApexClass:LedgerSync",
      "ApexClass:OldHelper",
    ];
    g.mergeNodes(names.map(node));
    const vectorStore = {
      init: async () => {},
      close: async () => {},
      countNodeVectors: () => names.length,
      getNodeVector: (_o: unknown, q: string) =>
        q === "ApexClass:Focal" ? new Float32Array([1, 0]) : null,
      searchNodes: () => [
        {
          qname: asQualifiedName("ApexClass:InvoiceBatch"),
          label: "ApexClass",
          distance: at(0.82),
        },
        {
          qname: asQualifiedName("ApexClass:InvoiceBatchRetry"),
          label: "ApexClass",
          distance: at(0.8),
        },
        {
          qname: asQualifiedName("ApexClass:InvoiceScheduler"),
          label: "ApexClass",
          distance: at(0.7),
        },
        { qname: asQualifiedName("ApexClass:LedgerSync"), label: "ApexClass", distance: at(0.45) },
        { qname: asQualifiedName("ApexClass:OldHelper"), label: "ApexClass", distance: at(0.35) },
      ],
    } as unknown as VectorStore;
    const ctx = { graphStore: g, snapshotStore: snap, orgId: asOrgId(ORG), vectorStore };
    setToolContextFactory(async () => ctx);
  }

  it("the default min_similarity (0.4) hides the weak match and says so in words and in data", async () => {
    await setup();
    const r = await callTool("find_similar", { org: ORG, qname: "ApexClass:Focal" });
    const d = r.data as {
      minSimilarity: number;
      cutByFloor: number;
      hits: Array<{ qname: string; foldedInto?: string }>;
    };
    expect(d.minSimilarity).toBe(0.4);
    expect(d.cutByFloor).toBe(1);
    expect(d.hits.map((h) => h.qname)).not.toContain("ApexClass:OldHelper");
    expect(section(r.markdown, "In short")).toContain(
      "1 weaker match was hidden below the similarity floor of 0.4",
    );

    const all = await callTool("find_similar", {
      org: ORG,
      qname: "ApexClass:Focal",
      min_similarity: 0,
    });
    expect((all.data as { hits: Array<{ qname: string }> }).hits.map((h) => h.qname)).toContain(
      "ApexClass:OldHelper",
    );
  });

  it("matches with similar names are listed as separate rows (no folding)", async () => {
    await setup();
    const r = await callTool("find_similar", { org: ORG, qname: "ApexClass:Focal" });
    const d = r.data as { hits: Array<Record<string, unknown>> };
    expect(d.hits.map((h) => h.qname)).toEqual([
      "ApexClass:InvoiceBatch",
      "ApexClass:InvoiceBatchRetry",
      "ApexClass:InvoiceScheduler",
      "ApexClass:LedgerSync",
    ]);
    expect(d.hits.some((h) => "foldedInto" in h)).toBe(false);
    expect(r.markdown).not.toContain("near-duplicate");
    const pieces = section(r.markdown, "What each piece does") ?? "";
    expect(pieces).toMatch(/^- `InvoiceBatchRetry`/m);
  });
});
