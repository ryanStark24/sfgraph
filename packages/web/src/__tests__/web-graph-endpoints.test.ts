import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { type NodeFact, SqliteGraphStore } from "@ryanstark24/sfgraph-core";
import { asOrgId } from "@ryanstark24/sfgraph-shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { GraphPayload } from "../api.js";
import { type ServeHandle, startWebServer } from "../server.js";
import { assertGraphIntegrity } from "./graph-integrity.js";

/**
 * Audit F11, F12, F13 through the real HTTP server (startWebServer), reading
 * temp on-disk stores. No org is contacted.
 */
const ORG = "00DAAAAAAAAAAAA";
const oid = asOrgId(ORG);

let tmpHome: string;
let prevHome: string | undefined;
let handle: ServeHandle;

const fact = (label: string, name: string): NodeFact => ({
  orgId: oid,
  label,
  qualifiedName: `${label}:${name}` as NodeFact["qualifiedName"],
  attributes: {},
  sourceHash: `h-${label}-${name}` as NodeFact["sourceHash"],
  firstSeenAt: 1,
  lastSeenAt: 1,
  lastModifiedAt: 1,
});

async function seed(fn: (s: SqliteGraphStore) => void): Promise<void> {
  const s = new SqliteGraphStore({ dbPath: path.join(tmpHome, `${ORG}.sqlite`) });
  await s.init();
  s.upsertOrg({ id: oid, alias: "acme", apiVersion: "65.0", instanceUrl: "", createdAt: 1 });
  fn(s);
  await s.close();
}

const edge = (src: string, dst: string, relType = "REFERENCES_OBJECT") => ({
  orgId: oid,
  srcQualifiedName: src as never,
  dstQualifiedName: dst as never,
  relType: relType as never,
  attributes: {},
  firstSeenAt: 1,
  lastSeenAt: 1,
});

async function get<T>(p: string): Promise<T> {
  const r = await fetch(`${handle.url}${p}`);
  expect(r.status, p).toBe(200);
  return (await r.json()) as T;
}

beforeEach(() => {
  tmpHome = mkdtempSync(path.join(tmpdir(), "sfg-web-graph-"));
  prevHome = process.env.SFGRAPH_DATA_DIR;
  process.env.SFGRAPH_DATA_DIR = tmpHome;
});

afterEach(async () => {
  await handle?.stop();
  // biome-ignore lint/performance/noDelete: assigning undefined to process.env coerces to the string "undefined"
  if (prevHome === undefined) delete process.env.SFGRAPH_DATA_DIR;
  else process.env.SFGRAPH_DATA_DIR = prevHome;
  rmSync(tmpHome, { recursive: true, force: true });
});

async function start(): Promise<void> {
  handle = await startWebServer({ port: 0, host: "127.0.0.1", log: () => {} });
}

describe("F11: /api/full and /api/labels use the labels actually stored", () => {
  it("includes an OmniScript and lists every stored label with counts", async () => {
    await seed((s) => {
      s.mergeNodes([
        fact("OmniScript", "HiddenScript"),
        fact("DataRaptor", "Extract1"),
        fact("CustomObject", "Account"),
        fact("ApexClass", "Consumer1"),
        fact("ApexClass", "Consumer2"),
      ]);
      s.mergeEdges([edge("ApexClass:Consumer1", "CustomObject:Account")]);
    });
    await start();
    const full = await get<GraphPayload>(`/api/full?org=${ORG}&limit=100`);
    expect(full.nodes.map((n) => n.id)).toContain("OmniScript:HiddenScript");
    expect(full.nodes.map((n) => n.id)).toContain("DataRaptor:Extract1");
    expect(full.nodes).toHaveLength(5);
    expect(full.truncated).toBe(false);
    expect(full.omittedNodes).toBe(0);
    expect(full.totalNodes).toBe(5);
    expect(full.excludedLabels).toEqual([]);
    assertGraphIntegrity(full, "/api/full");

    const labels = await get<Array<{ label: string; count: number }>>(`/api/labels?org=${ORG}`);
    expect(Object.fromEntries(labels.map((l) => [l.label, l.count]))).toEqual({
      OmniScript: 1,
      DataRaptor: 1,
      CustomObject: 1,
      ApexClass: 2,
    });
  });

  it("reports the node limit separately: truncated, omittedNodes, no dangling edges", async () => {
    await seed((s) => {
      s.mergeNodes([
        fact("OmniScript", "S1"),
        fact("ApexClass", "C1"),
        fact("ApexClass", "C2"),
        fact("CustomObject", "Account"),
      ]);
      s.mergeEdges([edge("ApexClass:C1", "CustomObject:Account")]);
    });
    await start();
    const full = await get<GraphPayload>(`/api/full?org=${ORG}&limit=2`);
    expect(full.nodes).toHaveLength(2);
    expect(full.truncated).toBe(true);
    expect(full.omittedNodes).toBe(2);
    expect(full.totalNodes).toBe(4);
    assertGraphIntegrity(full, "/api/full limit 2");
  });
});

describe("F12: capped /api/schema has no edges to absent nodes", () => {
  it("1 object + 3 consumers + limit 2: no dangling edges, omissions reported", async () => {
    await seed((s) => {
      s.mergeNodes([
        fact("CustomObject", "Account"),
        fact("ApexClass", "Consumer1"),
        fact("ApexClass", "Consumer2"),
        fact("ApexClass", "Consumer3"),
      ]);
      s.mergeEdges([1, 2, 3].map((i) => edge(`ApexClass:Consumer${i}`, "CustomObject:Account")));
    });
    await start();
    const g = await get<GraphPayload>(`/api/schema?org=${ORG}&limit=2`);
    expect(g.nodes).toHaveLength(2);
    assertGraphIntegrity(g, "/api/schema limit 2");
    expect(g.edges).toHaveLength(1);
    expect(g.truncated).toBe(true);
    expect(g.omittedNodes).toBe(2);

    const whole = await get<GraphPayload>(`/api/schema?org=${ORG}&limit=10`);
    expect(whole.nodes).toHaveLength(4);
    expect(whole.edges).toHaveLength(3);
    expect(whole.truncated).toBe(false);
    expect(whole.omittedNodes).toBe(0);
    assertGraphIntegrity(whole, "/api/schema limit 10");
  });

  it("counts an omitted seed once: object + 3 fields, limit 2", async () => {
    await seed((s) => {
      s.mergeNodes([
        fact("CustomObject", "Account"),
        fact("CustomField", "Account.F1__c"),
        fact("CustomField", "Account.F2__c"),
        fact("CustomField", "Account.F3__c"),
      ]);
    });
    await start();
    const g = await get<GraphPayload>(`/api/schema?org=${ORG}&limit=2`);
    expect(g.nodes).toHaveLength(2);
    expect(g.omittedNodes).toBe(2);
    expect(g.truncated).toBe(true);
    assertGraphIntegrity(g, "/api/schema seeds");
  });

  it("counts a refused seed once when it is met again through an edge", async () => {
    await seed((s) => {
      s.mergeNodes([
        fact("CustomObject", "Account"),
        fact("CustomField", "Account.F1__c"),
        fact("CustomField", "Account.F2__c"),
      ]);
      s.mergeEdges([
        edge("CustomField:Account.F1__c", "CustomObject:Account", "DEFINES_FIELD"),
        edge("CustomField:Account.F2__c", "CustomObject:Account", "DEFINES_FIELD"),
      ]);
    });
    await start();
    const g = await get<GraphPayload>(`/api/schema?org=${ORG}&limit=2`);
    expect(g.nodes).toHaveLength(2);
    expect(g.omittedNodes).toBe(1);
    assertGraphIntegrity(g, "/api/schema seed+edge");
  });

  it("every other graph endpoint satisfies endpoint integrity", async () => {
    await seed((s) => {
      s.mergeNodes([
        fact("CustomObject", "Account"),
        fact("ApexClass", "Consumer1"),
        fact("ApexClass", "Consumer2"),
        fact("ApexClass", "Consumer3"),
      ]);
      s.mergeEdges([1, 2, 3].map((i) => edge(`ApexClass:Consumer${i}`, "CustomObject:Account")));
    });
    await start();
    const q = encodeURIComponent("CustomObject:Account");
    for (const depth of [1, 2]) {
      assertGraphIntegrity(
        await get<GraphPayload>(`/api/neighborhood?org=${ORG}&qname=${q}&depth=${depth}`),
        `/api/neighborhood depth ${depth}`,
      );
    }
    for (const limit of [1, 2, 4]) {
      assertGraphIntegrity(
        await get<GraphPayload>(
          `/api/overview?org=${ORG}&labels=ApexClass,CustomObject&limit=${limit}`,
        ),
        `/api/overview limit ${limit}`,
      );
      assertGraphIntegrity(
        await get<GraphPayload>(`/api/full?org=${ORG}&limit=${limit}`),
        `/api/full ${limit}`,
      );
      assertGraphIntegrity(
        await get<GraphPayload>(`/api/schema?org=${ORG}&limit=${limit}`),
        `/api/schema ${limit}`,
      );
    }
  });
});

type SearchResp = { hits: Array<{ qname: string; label: string }>; truncated: boolean };

describe("F13: /api/search is a storage query with an incomplete flag", () => {
  it("finds Search49999 in a 50,000-node graph", async () => {
    await seed((s) => {
      s.transaction(() => {
        for (let b = 0; b < 50; b++) {
          s.mergeNodes(
            Array.from({ length: 1000 }, (_, i) =>
              fact("ApexClass", `Search${String(b * 1000 + i).padStart(5, "0")}`),
            ),
          );
        }
      });
    });
    await start();
    const r = await get<SearchResp>(`/api/search?org=${ORG}&q=Search49999&limit=25`);
    expect(r.hits).toEqual([{ qname: "ApexClass:Search49999", label: "ApexClass" }]);
    expect(r.truncated).toBe(false);
    // Case-insensitive, like the NOCASE column.
    const lower = await get<SearchResp>(`/api/search?org=${ORG}&q=search49999`);
    expect(lower.hits).toHaveLength(1);
    // More matches than the limit: first `limit` returned and truncated says so.
    const many = await get<SearchResp>(`/api/search?org=${ORG}&q=Search4&limit=10`);
    expect(many.hits).toHaveLength(10);
    expect(many.truncated).toBe(true);
  }, 60_000);

  it("treats % and _ in the query as literal text", async () => {
    await seed((s) => {
      s.mergeNodes([
        fact("ApexClass", "Rate100%Done"),
        fact("ApexClass", "RateXXXDone"),
        fact("ApexClass", "My_Class"),
        fact("ApexClass", "MyXClass"),
        fact("ApexClass", "Back\\Slash"),
      ]);
    });
    await start();
    const pct = await get<SearchResp>(`/api/search?org=${ORG}&q=${encodeURIComponent("100%D")}`);
    expect(pct.hits.map((h) => h.qname)).toEqual(["ApexClass:Rate100%Done"]);
    const us = await get<SearchResp>(`/api/search?org=${ORG}&q=${encodeURIComponent("y_C")}`);
    expect(us.hits.map((h) => h.qname)).toEqual(["ApexClass:My_Class"]);
    const bs = await get<SearchResp>(`/api/search?org=${ORG}&q=${encodeURIComponent("k\\S")}`);
    expect(bs.hits.map((h) => h.qname)).toEqual(["ApexClass:Back\\Slash"]);
  });
});

describe("audit notes: edge case match, fair node limit, neighbourhood count", () => {
  it("N4: an edge stored with another spelling of the target still shows in /api/full and /api/overview", async () => {
    await seed((s) => {
      s.mergeNodes([fact("ApexClass", "Svc"), fact("CustomObject", "Acme_Order__c")]);
      // Stored with different case; the store matches names without ASCII case.
      s.mergeEdges([edge("ApexClass:Svc", "customobject:ACME_ORDER__C")]);
    });
    await start();
    const full = await get<GraphPayload>(`/api/full?org=${ORG}&limit=100`);
    expect(full.edges).toEqual([
      {
        source: "ApexClass:Svc",
        target: "CustomObject:Acme_Order__c",
        relType: "REFERENCES_OBJECT",
      },
    ]);
    assertGraphIntegrity(full, "/api/full case");
    const ov = await get<GraphPayload>(
      `/api/overview?org=${ORG}&labels=ApexClass,CustomObject&limit=100`,
    );
    expect(ov.edges).toEqual(full.edges);
    assertGraphIntegrity(ov, "/api/overview case");
  });

  it("N2: 50,000 ApexClass + 1 OmniScript at limit 15000 keeps the OmniScript and names ApexClass as cut", async () => {
    await seed((s) => {
      s.transaction(() => {
        for (let b = 0; b < 50; b++) {
          s.mergeNodes(
            Array.from({ length: 1000 }, (_, i) =>
              fact("ApexClass", `Cls${String(b * 1000 + i).padStart(5, "0")}`),
            ),
          );
        }
        s.mergeNodes([fact("OmniScript", "Acme_Intake")]);
      });
    });
    await start();
    const full = await get<GraphPayload>(`/api/full?org=${ORG}&limit=15000`);
    expect(full.nodes).toHaveLength(15_000);
    expect(full.nodes.map((n) => n.id)).toContain("OmniScript:Acme_Intake");
    expect(full.truncated).toBe(true);
    expect(full.omittedNodes).toBe(35_001);
    expect(full.omittedByLabel).toEqual([{ label: "ApexClass", omitted: 35_001 }]);
  }, 60_000);

  it("N2: several small labels each keep a share; every cut label is listed", async () => {
    await seed((s) => {
      s.mergeNodes([
        ...Array.from({ length: 10 }, (_, i) => fact("ApexClass", `C${i}`)),
        ...Array.from({ length: 6 }, (_, i) => fact("Flow", `F${i}`)),
        fact("OmniScript", "S1"),
      ]);
    });
    await start();
    const full = await get<GraphPayload>(`/api/full?org=${ORG}&limit=9`);
    const per = (l: string) => full.nodes.filter((n) => n.label === l).length;
    expect([per("OmniScript"), per("Flow"), per("ApexClass")]).toEqual([1, 4, 4]);
    expect(full.omittedByLabel).toEqual([
      { label: "ApexClass", omitted: 6 },
      { label: "Flow", omitted: 2 },
    ]);
    const whole = await get<GraphPayload>(`/api/full?org=${ORG}&limit=100`);
    expect(whole.omittedByLabel).toEqual([]);
  });

  it("N6: /api/neighborhood reports how many neighbours the cap left out", async () => {
    await seed((s) => {
      const names = Array.from({ length: 300 }, (_, i) => `C${String(i).padStart(3, "0")}`);
      s.mergeNodes([fact("CustomObject", "Account"), ...names.map((n) => fact("ApexClass", n))]);
      s.mergeEdges(names.map((n) => edge(`ApexClass:${n}`, "CustomObject:Account")));
    });
    await start();
    const q = encodeURIComponent("CustomObject:Account");
    const g = await get<GraphPayload>(`/api/neighborhood?org=${ORG}&qname=${q}&depth=1`);
    expect(g.nodes).toHaveLength(250);
    expect(g.truncated).toBe(true);
    expect(g.omittedNodes).toBe(51);
    assertGraphIntegrity(g, "/api/neighborhood cap");
    const small = await get<GraphPayload>(
      `/api/neighborhood?org=${ORG}&qname=${encodeURIComponent("ApexClass:C000")}&depth=1`,
    );
    expect(small.truncated).toBe(false);
    expect(small.omittedNodes).toBe(0);
  });
});
