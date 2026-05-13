import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { asOrgId, asQualifiedName, asSha256 } from "@sfgraph/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { EdgeFact, NodeFact } from "../../domain/index.js";
import { SqliteGraphStore } from "../sqlite/graph-store.js";
import { SqliteSnapshotStore } from "../sqlite/snapshot-store.js";

let workDir: string;

beforeEach(() => {
  workDir = mkdtempSync(path.join(tmpdir(), "sfg-perf-"));
});

afterEach(() => {
  rmSync(workDir, { recursive: true, force: true });
});

describe("perf: 50k ingest + snapshot + diff", () => {
  it.skipIf(process.env.CI)(
    "completes in under 5000ms",
    async () => {
      const dbPath = path.join(workDir, "perf.sqlite");
      const graph = new SqliteGraphStore({ dbPath, backupDir: path.join(workDir, "bkp") });
      await graph.init();
      const snap = new SqliteSnapshotStore({ dbPath, db: graph.db, skipMigrations: true });
      await snap.init();

      const labels = ["ApexClass", "Flow", "LWC", "CustomObject", "CustomField"];
      const relTypes = ["CALLS", "READS_FIELD", "WRITES_FIELD", "CONTAINS", "REFERENCES"];
      const total = 50_000;
      const nodes: NodeFact[] = new Array(total);
      for (let i = 0; i < total; i += 1) {
        const lbl = labels[i % labels.length] as string;
        nodes[i] = {
          orgId: asOrgId("org1"),
          qualifiedName: asQualifiedName(`${lbl}.N${i}`),
          label: lbl,
          attributes: { i },
          sourceHash: asSha256(`h${i}`),
          firstSeenAt: i,
          lastSeenAt: i,
          lastModifiedAt: i,
        };
      }
      const edges: EdgeFact[] = new Array(total);
      for (let i = 0; i < total; i += 1) {
        const rt = relTypes[i % relTypes.length] as string;
        const srcL = labels[i % labels.length] as string;
        const dstL = labels[(i + 1) % labels.length] as string;
        edges[i] = {
          orgId: asOrgId("org1"),
          srcQualifiedName: asQualifiedName(`${srcL}.N${i}`),
          dstQualifiedName: asQualifiedName(`${dstL}.N${(i + 1) % total}`),
          relType: rt as EdgeFact["relType"],
          attributes: {},
          firstSeenAt: i,
          lastSeenAt: i,
        };
      }

      const t0 = performance.now();
      graph.mergeNodes(nodes);
      graph.mergeEdges(edges);
      const s = snap.createSnapshot(asOrgId("org1"), "perf", true);
      snap.diffNodes(asOrgId("org1"), s.id, "current");
      const elapsed = performance.now() - t0;

      // eslint-disable-next-line no-console
      console.log(`perf-50k: ${elapsed.toFixed(0)}ms`);
      expect(elapsed).toBeLessThan(5000);
      await graph.close();
    },
    30_000,
  );
});
