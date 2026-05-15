import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { asOrgId, asQualifiedName, asSha256 } from "@ryanstark24/sfgraph-shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { REL_TYPES } from "../../domain/index.js";
import type { EdgeFact, NodeFact } from "../../domain/index.js";
import { SqliteGraphStore } from "../../storage/index.js";
import { findDependencies } from "../dependencies.js";
import { TRAVERSAL_NODE_CAP_DEFAULT, findDependents } from "../dependents.js";

let workDir: string;
let store: SqliteGraphStore;
const orgId = asOrgId("orgCap");

beforeEach(async () => {
  workDir = mkdtempSync(path.join(tmpdir(), "sfg-caps-"));
  store = new SqliteGraphStore({
    dbPath: path.join(workDir, "g.sqlite"),
    backupDir: path.join(workDir, "bkp"),
  });
  await store.init();
});

afterEach(async () => {
  // biome-ignore lint/performance/noDelete: cleanest reset of an env var override
  delete process.env.SFGRAPH_TRAVERSAL_NODE_CAP;
  await store.close();
  rmSync(workDir, { recursive: true, force: true });
});

function makeHub(width: number): void {
  const nodes: NodeFact[] = [
    {
      orgId,
      qualifiedName: asQualifiedName("ApexClass:Hub"),
      label: "ApexClass",
      attributes: {},
      sourceHash: asSha256("h-hub"),
      firstSeenAt: 1,
      lastSeenAt: 1,
      lastModifiedAt: 1,
    },
  ];
  const edges: EdgeFact[] = [];
  for (let i = 0; i < width; i++) {
    nodes.push({
      orgId,
      qualifiedName: asQualifiedName(`ApexClass:Leaf${i}`),
      label: "ApexClass",
      attributes: {},
      sourceHash: asSha256(`h-${i}`),
      firstSeenAt: 1,
      lastSeenAt: 1,
      lastModifiedAt: 1,
    });
    edges.push({
      orgId,
      srcQualifiedName: asQualifiedName(`ApexClass:Leaf${i}`),
      dstQualifiedName: asQualifiedName("ApexClass:Hub"),
      relType: REL_TYPES.CALLS as never,
      attributes: {},
      firstSeenAt: 1,
      lastSeenAt: 1,
    });
  }
  store.mergeNodes(nodes);
  store.mergeEdges(edges);
}

describe("findDependents / findDependencies node-cap", () => {
  it("returns truncated=false when graph fits under the cap", () => {
    makeHub(10);
    const r = findDependents(store, orgId, asQualifiedName("ApexClass:Hub"));
    expect(r.truncated).toBe(false);
    expect(r.nodes.length).toBe(10);
  });

  it("returns truncated=true when frontier exceeds default cap", () => {
    makeHub(TRAVERSAL_NODE_CAP_DEFAULT + 50);
    const r = findDependents(store, orgId, asQualifiedName("ApexClass:Hub"));
    expect(r.truncated).toBe(true);
    expect(r.nodes.length).toBeLessThanOrEqual(TRAVERSAL_NODE_CAP_DEFAULT);
  });

  it("honors SFGRAPH_TRAVERSAL_NODE_CAP override", () => {
    process.env.SFGRAPH_TRAVERSAL_NODE_CAP = "5";
    makeHub(50);
    const r = findDependents(store, orgId, asQualifiedName("ApexClass:Hub"));
    expect(r.truncated).toBe(true);
    expect(r.nodes.length).toBeLessThanOrEqual(5);
  });

  it("findDependencies (forward) also caps", () => {
    process.env.SFGRAPH_TRAVERSAL_NODE_CAP = "3";
    // Same shape but use forward edges from Hub.
    const nodes: NodeFact[] = [
      {
        orgId,
        qualifiedName: asQualifiedName("ApexClass:Hub"),
        label: "ApexClass",
        attributes: {},
        sourceHash: asSha256("h-hub"),
        firstSeenAt: 1,
        lastSeenAt: 1,
        lastModifiedAt: 1,
      },
    ];
    const edges: EdgeFact[] = [];
    for (let i = 0; i < 20; i++) {
      nodes.push({
        orgId,
        qualifiedName: asQualifiedName(`ApexClass:Out${i}`),
        label: "ApexClass",
        attributes: {},
        sourceHash: asSha256(`h-${i}`),
        firstSeenAt: 1,
        lastSeenAt: 1,
        lastModifiedAt: 1,
      });
      edges.push({
        orgId,
        srcQualifiedName: asQualifiedName("ApexClass:Hub"),
        dstQualifiedName: asQualifiedName(`ApexClass:Out${i}`),
        relType: REL_TYPES.CALLS as never,
        attributes: {},
        firstSeenAt: 1,
        lastSeenAt: 1,
      });
    }
    store.mergeNodes(nodes);
    store.mergeEdges(edges);
    const r = findDependencies(store, orgId, asQualifiedName("ApexClass:Hub"));
    expect(r.truncated).toBe(true);
    expect(r.nodes.length).toBeLessThanOrEqual(3);
  });
});
