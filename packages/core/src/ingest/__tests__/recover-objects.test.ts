import { asOrgId, asQualifiedName, asSha256 } from "@ryanstark24/sfgraph-shared";
import { describe, expect, it } from "vitest";
import type { EdgeFact, NodeFact } from "../../domain/index.js";
import { buildObjectEnvelope } from "../../extractors/live-org/extractors/object.js";
import { makeTestCtx } from "../../parsers/__tests__/_harness.js";
import { OpaqueNodeParser } from "../../parsers/generic/opaque-node-parser.js";
import { SqliteGraphStore } from "../../storage/sqlite/graph-store.js";
import {
  recoverObjectsEnabled,
  recoverObjectsMax,
  recoverReferencedObjects,
} from "../recover-objects.js";

const ORG = asOrgId("org_recover");
const ts = Date.now();

function node(label: string, qname: string, attributes: Record<string, unknown> = {}): NodeFact {
  return {
    orgId: ORG,
    qualifiedName: asQualifiedName(qname),
    label,
    attributes,
    sourceHash: asSha256(qname),
    firstSeenAt: ts,
    lastSeenAt: ts,
    lastModifiedAt: ts,
  };
}
function edge(src: string, rel: string, dst: string): EdgeFact {
  return {
    orgId: ORG,
    srcQualifiedName: asQualifiedName(src),
    dstQualifiedName: asQualifiedName(dst),
    relType: rel as never,
    attributes: {},
    firstSeenAt: ts,
    lastSeenAt: ts,
  };
}

async function setup() {
  const s = new SqliteGraphStore({ dbPath: ":memory:" });
  await s.init();
  s.upsertOrg({
    id: ORG,
    alias: "t",
    instanceUrl: "https://example.test",
    apiVersion: "60.0",
    createdAt: ts,
  });
  return s;
}

function fakeConn(sobjects: string[], failing: string[] = []) {
  const calls = { describeGlobal: 0, describe: [] as string[] };
  const conn = {
    describeGlobal: async () => {
      calls.describeGlobal += 1;
      return { sobjects: sobjects.map((name) => ({ name, queryable: true })) };
    },
    sobject: (name: string) => ({
      describe: async () => {
        calls.describe.push(name);
        if (failing.includes(name)) throw new Error("boom");
        return {
          name,
          label: name,
          fields: [
            { name: "Id", type: "id" },
            { name: "Name", type: "string" },
          ],
        };
      },
    }),
  };
  return { conn, calls };
}

describe("reference-driven object recovery", () => {
  it("makes no API call at all when nothing references a missing object", async () => {
    const s = await setup();
    s.mergeNodes([node("ApexClass", "ApexClass:A"), node("CustomObject", "CustomObject:Account")]);
    s.mergeEdges([edge("ApexClass:A", "EXECUTES_SOQL", "CustomObject:Account")]);
    const { conn, calls } = fakeConn(["Account"]);
    const applied: string[] = [];
    const r = await recoverReferencedObjects({
      conn,
      graph: s,
      orgId: ORG,
      apply: (m) => void applied.push(m.ref.memberName),
    });
    expect(r.summary).toBe("");
    expect(calls.describeGlobal).toBe(0);
    expect(calls.describe).toEqual([]);
    expect(applied).toEqual([]);
  });

  it("recovers referenced objects the org lists; skips names it does not list; honours the cap", async () => {
    const s = await setup();
    const scanned = await new OpaqueNodeParser().parse(
      { metadataType: "NewCloudThing", name: "T", raw: JSON.stringify({ objectName: "Gated__c" }) },
      { ...makeTestCtx(), orgId: ORG },
    );
    s.mergeNodes([
      node("ApexClass", "ApexClass:A"),
      node("ApexClass", "ApexClass:B"),
      { ...scanned.nodes[0]!, orgId: ORG },
    ]);
    s.mergeEdges([
      edge("ApexClass:A", "EXECUTES_SOQL", "CustomObject:AccountHistory"),
      edge("ApexClass:A", "READS_FIELD", "CustomField:Contract__b.Amount__c"),
      edge("ApexClass:B", "EXECUTES_SOQL", "CustomObject:NotAnObject"),
      edge("ApexClass:B", "EXECUTES_DML", "CustomObject:Third__c"),
    ]);
    const { conn, calls } = fakeConn(["AccountHistory", "Contract__b", "Gated__c", "Third__c"]);
    const applied: Array<{ name: string; content: string }> = [];
    const r = await recoverReferencedObjects({
      conn,
      graph: s,
      orgId: ORG,
      max: 3,
      apply: (m) => void applied.push({ name: m.ref.memberName, content: m.content }),
    });
    expect(calls.describeGlobal).toBe(1);
    expect(calls.describe.length).toBe(3);
    expect(r.recovered.length).toBe(3);
    expect(r.notInOrg).toBe(1); // NotAnObject
    expect(r.capped).toBe(1); // 4 real, cap 3
    expect(applied[0]?.content).toContain("<fullName>");
    expect(r.summary).toMatch(/3 recovered, 1 not an SObject in this org, 1 over the cap of 3/);
  });

  it("counts a failed or timed-out describe and carries on", async () => {
    const s = await setup();
    s.mergeNodes([node("ApexClass", "ApexClass:A")]);
    s.mergeEdges([
      edge("ApexClass:A", "EXECUTES_SOQL", "CustomObject:Bad__c"),
      edge("ApexClass:A", "EXECUTES_SOQL", "CustomObject:Good__c"),
    ]);
    const { conn } = fakeConn(["Bad__c", "Good__c"], ["Bad__c"]);
    const applied: string[] = [];
    const r = await recoverReferencedObjects({
      conn,
      graph: s,
      orgId: ORG,
      retry: { retries: 0, retryBackoffMs: 0 },
      apply: (m) => void applied.push(m.ref.memberName),
    });
    expect(applied).toEqual(["Good__c"]);
    expect(r.failed).toBe(1);
    expect(r.summary).toMatch(/1 failed/);
  });

  it("does not recover an object the developer excluded with SFGRAPH_SKIP_SOBJECT", async () => {
    const s = await setup();
    s.mergeNodes([node("ApexClass", "ApexClass:A")]);
    s.mergeEdges([edge("ApexClass:A", "EXECUTES_SOQL", "CustomObject:Skip__c")]);
    const { conn, calls } = fakeConn(["Skip__c"]);
    const r = await recoverReferencedObjects({
      conn,
      graph: s,
      orgId: ORG,
      env: { SFGRAPH_SKIP_SOBJECT: "Skip__c" },
      apply: () => {},
    });
    expect(calls.describeGlobal).toBe(0);
    expect(r.summary).toBe("");
  });

  it("env switches and the envelope", () => {
    expect(recoverObjectsEnabled({})).toBe(true);
    expect(recoverObjectsEnabled({ SFGRAPH_RECOVER_OBJECTS: "0" })).toBe(false);
    expect(recoverObjectsMax({})).toBe(50);
    expect(recoverObjectsMax({ SFGRAPH_RECOVER_OBJECTS_MAX: "7" })).toBe(7);
    expect(recoverObjectsMax({ SFGRAPH_RECOVER_OBJECTS_MAX: "x" })).toBe(50);
    expect(
      buildObjectEnvelope({ name: "Foo__c" }, { fields: [{ name: "Bar__c", type: "string" }] }),
    ).toContain("Bar__c");
  });
});
