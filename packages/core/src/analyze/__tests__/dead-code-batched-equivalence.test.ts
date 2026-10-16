import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { ConsoleLogger, asOrgId, asQualifiedName, asSha256 } from "@ryanstark24/sfgraph-shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { EdgeFact, NodeFact } from "../../domain/index.js";
import { FilesystemMetadataSource } from "../../extractors/filesystem/index.js";
import { runDeltaIngest } from "../../ingest/delta.js";
import { liveIngest } from "../../ingest/live-ingest.js";
import { offlineResolvedOrg } from "../../ingest/offline-org.js";
import type { GraphStore } from "../../storage/interfaces.js";
import { SqliteGraphStore } from "../../storage/sqlite/graph-store.js";
import { type DeadCodeCandidate, deadCodeCandidates, scoreDeadCode } from "../dead-code.js";
import { readDeadCodeScores } from "../populate.js";

/**
 * deadCodeCandidates reads incoming edges, members and test tags in batches
 * (listEdgesToAny / listEdgesFromAny / listNodesWithTrueAttribute). The
 * reference is the same function on a store without those methods, which
 * takes the original per-node path (one listEdgesTo per target, one getNode
 * per source). Both must give the same candidates, and the score cache an
 * ingest or a delta writes must equal a full per-node re-score.
 */

/** The store with the batched reads hidden: deadCodeCandidates' per-node path. */
function perNode(store: GraphStore): GraphStore {
  const hidden = new Set(["listEdgesToAny", "listEdgesFromAny", "listNodesWithTrueAttribute"]);
  return new Proxy(store, {
    get(target, prop, receiver) {
      if (typeof prop === "string" && hidden.has(prop)) return undefined;
      const v = Reflect.get(target, prop, receiver);
      return typeof v === "function" ? v.bind(target) : v;
    },
  });
}

const shape = (cs: DeadCodeCandidate[]) =>
  cs.map((c) => ({
    q: String(c.node.qualifiedName),
    kind: c.kind,
    isTest: c.isTest,
    testOnlyRefs: c.testOnlyRefs,
  }));

const ORG = asOrgId("org_eq");
function node(label: string, q: string, attributes: Record<string, unknown> = {}): NodeFact {
  return {
    orgId: ORG,
    qualifiedName: asQualifiedName(q),
    label,
    attributes,
    sourceHash: asSha256(q),
    firstSeenAt: 1,
    lastSeenAt: 1,
    lastModifiedAt: 1,
  };
}
function edge(rel: string, src: string, dst: string, attributes = {}): EdgeFact {
  return {
    orgId: ORG,
    srcQualifiedName: asQualifiedName(src),
    dstQualifiedName: asQualifiedName(dst),
    relType: rel as EdgeFact["relType"],
    attributes,
    firstSeenAt: 1,
    lastSeenAt: 1,
  };
}

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "sfg-dc-eq-"));
  vi.spyOn(console, "log").mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
  rmSync(dir, { recursive: true, force: true });
});

describe("batched dead-code candidates", () => {
  it("equal the per-node path on a graph with every reference rule", async () => {
    const store = new SqliteGraphStore({ dbPath: ":memory:", backupDir: path.join(dir, "bk") });
    await store.init();
    const nodes: NodeFact[] = [];
    const edges: EdgeFact[] = [];
    for (let i = 0; i < 300; i++) {
      // Spread over more than one INCOMING_CHUNK, with every rule in play.
      const c = `ApexClass:C${i}`;
      nodes.push(node("ApexClass", c, i % 17 === 0 ? { isTest: true } : {}));
      for (let m = 0; m < 3; m++) {
        const meth = `ApexMethod:C${i}.m${m}(0)`;
        nodes.push(
          node(
            i % 13 === 0 && m === 0 ? "TestMethod" : "ApexMethod",
            meth,
            i % 13 === 0 && m === 0 ? { isTest: true } : {},
          ),
        );
        edges.push(edge("CONTAINS_METHOD", c, meth));
      }
      const tgt = (i * 7) % 300;
      switch (i % 9) {
        case 0: // call into a member, NOCASE-varied spelling
          edges.push(edge("CALLS", `ApexMethod:C${i}.m1(0)`, `apexmethod:c${tgt}.M2(0)`));
          break;
        case 1: // grant (not usage)
          edges.push(edge("GRANTS_CLASS_ACCESS", "Profile:Admin", `ApexClass:C${tgt}`));
          break;
        case 2: // reflection guess (not usage) and a CMDT-named class (usage)
          edges.push(
            edge("REFERENCES", `ApexClass:C${i}`, `ApexClass:C${tgt}`, { source: "reflection" }),
          );
          edges.push(
            edge("REFERENCES", "CustomMetadataRecord:H.x", `ApexClass:C${(tgt + 1) % 300}`, {
              source: "reflection",
            }),
          );
          break;
        case 3: // test-only reference
          edges.push(edge("IS_TEST_FOR", `ApexClass:C${i}`, `ApexClass:C${tgt}`));
          break;
        case 4: // call from a test method / untagged method of a test class
          edges.push(
            edge("CALLS", `ApexMethod:C${(i - 4 + 300) % 300}.m0(0)`, `ApexMethod:C${tgt}.m0(0)`),
          );
          break;
        case 5: // internal call (self) does not count
          edges.push(edge("CALLS", `ApexMethod:C${i}.m0(0)`, `ApexMethod:C${i}.m1(0)`));
          break;
        default:
          edges.push(edge("REFERENCES", `Flow:F${i}`, `ApexClass:C${tgt}`));
      }
    }
    // LWC: own bundle (structure), compiled-OmniScript edge (counts only when launched).
    for (let i = 0; i < 20; i++) {
      nodes.push(node("LWC", `LWC:w${i}`));
      nodes.push(node("LWCBundle", `LWCBundle:w${i}`));
      edges.push(edge("CONTAINS_COMPONENT", `LWCBundle:w${i}`, `LWC:w${i}`));
      nodes.push(node("Flow", `Flow:F${i}`));
      edges.push(edge("REFERENCES", `LWC:w${i}`, `Flow:F${i}`, { via: "compiled-omniscript" }));
      if (i % 2 === 0) edges.push(edge("REFERENCES", `FlexiPage:P${i}`, `LWC:w${i}`));
    }
    store.mergeNodes(nodes);
    store.mergeEdges(edges);

    const fast = deadCodeCandidates(store, ORG);
    const ref = deadCodeCandidates(perNode(store), ORG);
    expect(shape(fast)).toEqual(shape(ref));
    // Every kind and flag occurs, so the comparison is not vacuous.
    const kinds = new Set(fast.map((c) => `${c.kind}:${c.isTest}:${c.testOnlyRefs > 0}`));
    expect(kinds).toContain("dead:false:false");
    expect(kinds).toContain("dead:true:false");
    expect(kinds).toContain("referenced-only-by-tests:false:true");
    expect(fast.length).toBeLessThan(nodes.length);
    await store.close();
  });

  it("leaves a delta's score cache equal to a full per-node re-score", async () => {
    const proj = path.join(dir, "proj");
    cpSync(path.resolve(__dirname, "../../ingest/__tests__/fixtures/delta-project"), proj, {
      recursive: true,
    });
    const dbPath = path.join(dir, "g.sqlite");
    const store = new SqliteGraphStore({ dbPath, backupDir: path.join(dir, "bk") });
    await store.init();
    const logger = new ConsoleLogger("error");
    const base = {
      alias: "fixture",
      graphStore: store,
      preResolved: offlineResolvedOrg(proj, "fixture"),
      logger,
      skipSnapshot: true,
      analysisDb: store.db,
      parsePool: { workers: 0 },
    };
    await liveIngest({
      ...base,
      mode: "full",
      rebuild: true,
      metadataSource: FilesystemMetadataSource.fromProjectRoot(proj),
    });
    const orgId = base.preResolved.orgId;
    const check = (): number => {
      const rows = readDeadCodeScores(store.db, orgId);
      expect(rows).not.toBeNull();
      const got = (rows ?? []).map((r) => ({
        q: r.qualifiedName,
        score: r.score,
        confidence: r.confidence,
        reasons: r.reasons,
      }));
      const now = rows?.[0]?.computedAt ?? Date.now();
      const want = deadCodeCandidates(perNode(store), orgId)
        .map(({ node: n, testOnlyRefs, isTest }) => ({
          q: String(n.qualifiedName),
          ...scoreDeadCode(n, now, testOnlyRefs, isTest),
        }))
        .sort((x, y) => x.score - y.score || x.q.localeCompare(y.q));
      expect(got).toEqual(want);
      return got.length;
    };
    expect(check()).toBeGreaterThan(0);

    // One-file delta: Util loses its only caller, a new class appears.
    const svc = path.join(proj, "force-app/main/default/classes/AccountService.cls");
    writeFileSync(svc, readFileSync(svc, "utf8").replace("Util.log(msg);", ""));
    writeFileSync(
      path.join(proj, "force-app/main/default/classes/Fresh.cls"),
      "public class Fresh { public static void go() { OrderHelper.touch(null); } }",
    );
    const r = await runDeltaIngest({
      ...base,
      metadataSource: FilesystemMetadataSource.fromProjectRoot(proj),
      report: () => {},
      fullRebuild: async () => {
        throw new Error("unexpected full rebuild");
      },
    });
    expect(r.kind).toBe("delta");
    expect(check()).toBeGreaterThan(0);
    await store.close();
  });
});
