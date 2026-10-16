import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { asOrgId, asQualifiedName } from "@ryanstark24/sfgraph-shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { EdgeFact } from "../../domain/index.js";
import { SqliteGraphStore } from "../sqlite/graph-store.js";

/**
 * mergeEdges against a plain in-memory model of its contract, over random
 * batches built to hit the edge cases of the reconcile path: case variants of
 * one key (NOCASE), a key repeated in one batch (unchanged then changed and
 * the reverse), foreign-pass edges (source / resolvedBy, never pruned), extra
 * reconcile sources, rel types created mid-run, two orgs, and non-reconcile
 * batches. Every row (stored spelling, attributes, first/last seen) and every
 * returned count must match the model after each call.
 */

interface Row {
  src: string;
  dst: string;
  attributes: string;
  first: number;
  last: number;
}

const lc = (s: string): string => s.replace(/[A-Z]/g, (c) => c.toLowerCase());
const SEP = "\u001f";

class Model {
  rows = new Map<string, Row>(); // org|rel|lc(src)|lc(dst)

  merge(facts: EdgeFact[], reconcile: boolean, extras: { org: string; qnames: string[] } | null) {
    const res = { inserted: 0, updated: 0, unchanged: 0, deleted: 0 };
    const buckets = new Map<string, EdgeFact[]>();
    for (const f of facts) {
      const b = buckets.get(f.relType) ?? [];
      b.push(f);
      buckets.set(f.relType, b);
    }
    for (const [rel, bucket] of buckets) {
      for (const f of bucket) {
        const k = [f.orgId, rel, lc(f.srcQualifiedName), lc(f.dstQualifiedName)].join(SEP);
        const a = JSON.stringify(f.attributes);
        const r = this.rows.get(k);
        if (!r) {
          this.rows.set(k, {
            src: f.srcQualifiedName,
            dst: f.dstQualifiedName,
            attributes: a,
            first: f.firstSeenAt,
            last: f.lastSeenAt,
          });
          res.inserted += 1;
        } else if (r.attributes !== a) {
          r.attributes = a;
          r.last = f.lastSeenAt;
          res.updated += 1;
        } else {
          r.last = f.lastSeenAt;
          res.unchanged += 1;
        }
      }
    }
    if (reconcile) {
      const owned = new Set<string>();
      const emitted = new Set<string>();
      for (const f of facts) {
        owned.add(`${f.orgId}${SEP}${lc(f.srcQualifiedName)}`);
        emitted.add([f.orgId, f.relType, lc(f.srcQualifiedName), lc(f.dstQualifiedName)].join(SEP));
      }
      if (extras) for (const q of extras.qnames) owned.add(`${extras.org}${SEP}${lc(q)}`);
      for (const [k, r] of [...this.rows]) {
        const [org] = k.split(SEP);
        if (!owned.has(`${org}${SEP}${lc(r.src)}`) || emitted.has(k)) continue;
        const attrs = JSON.parse(r.attributes) as Record<string, unknown>;
        if (attrs.source != null || attrs.resolvedBy != null) continue;
        this.rows.delete(k);
        res.deleted += 1;
      }
    }
    return res;
  }
}

function dump(store: SqliteGraphStore): Map<string, Row> {
  const out = new Map<string, Row>();
  for (const [rel, tbl] of store.getEdgeRelTables()) {
    const rows = store.db
      .prepare(
        `SELECT org_id, src_qname, dst_qname, attributes, first_seen_at, last_seen_at FROM ${tbl}`,
      )
      .all() as Array<{
      org_id: string;
      src_qname: string;
      dst_qname: string;
      attributes: string;
      first_seen_at: number;
      last_seen_at: number;
    }>;
    for (const r of rows) {
      out.set([r.org_id, rel, lc(r.src_qname), lc(r.dst_qname)].join(SEP), {
        src: r.src_qname,
        dst: r.dst_qname,
        attributes: r.attributes,
        first: r.first_seen_at,
        last: r.last_seen_at,
      });
    }
  }
  return out;
}

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "sfg-merge-model-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("mergeEdges matches its model", () => {
  it("on a key repeated within one reconcile batch", async () => {
    const store = new SqliteGraphStore({
      dbPath: path.join(dir, "rep.sqlite"),
      backupDir: path.join(dir, "bk"),
    });
    await store.init();
    const model = new Model();
    const e = (dst: string, attributes: Record<string, unknown>, last: number): EdgeFact => ({
      orgId: asOrgId("00DORGA"),
      srcQualifiedName: asQualifiedName("ApexClass:A"),
      dstQualifiedName: asQualifiedName(dst),
      relType: "CALLS" as EdgeFact["relType"],
      attributes,
      firstSeenAt: last,
      lastSeenAt: last,
    });
    const batches: EdgeFact[][] = [
      [e("X:1", { k: 1 }, 1), e("X:2", { k: 1 }, 1), e("X:3", { k: 1 }, 1)],
      // unchanged then changed: the changed write is last
      [e("X:1", { k: 1 }, 5), e("x:1", { k: 2 }, 7), e("X:2", { k: 1 }, 2), e("X:3", { k: 1 }, 2)],
      // changed then unchanged (vs the new value) with an older stamp
      [e("X:1", { k: 3 }, 9), e("X:1", { k: 3 }, 8), e("X:2", { k: 1 }, 3)],
      // unchanged, unchanged with different stamps; a new key twice
      [e("X:2", { k: 1 }, 6), e("X:2", { k: 1 }, 4), e("X:9", { k: 1 }, 6), e("X:9", { k: 1 }, 5)],
    ];
    for (const facts of batches) {
      const got = store.mergeEdges(facts, { reconcileSources: true });
      expect(got).toEqual(model.merge(facts, true, null));
      expect(dump(store)).toEqual(model.rows);
    }
    await store.close();
  });

  it("over random reconcile and plain batches", async () => {
    const store = new SqliteGraphStore({
      dbPath: path.join(dir, "g.sqlite"),
      backupDir: path.join(dir, "bk"),
    });
    await store.init();
    const model = new Model();
    let seed = 7;
    const rnd = (n: number): number => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed % n;
    };
    const pick = <T>(xs: readonly T[]): T => xs[rnd(xs.length)] as T;
    const orgs = ["00DORGA", "00DORGB"];
    const srcs = ["ApexMethod:A.x(0)", "apexmethod:a.X(0)", "ApexClass:B", "ApexClass:b", "Flow:F"];
    const dsts = [
      "CustomField:Account.Tier__c",
      "customfield:account.tier__c",
      "ApexClass:C",
      "X:Ünï",
      "X:ünï",
    ];
    const attrs: Array<Record<string, unknown>> = [
      { k: 1 },
      { k: 2 },
      { k: 1, line: 3 },
      { source: "mcd" },
      { resolvedBy: "arity" },
      {},
    ];
    let rels = ["CALLS", "REFERENCES", "READS_FIELD"];
    for (let round = 0; round < 400; round++) {
      if (round % 60 === 59) rels = [...rels, `NEW_REL_${round}`];
      const org = pick(orgs);
      const n = 1 + rnd(8);
      const facts: EdgeFact[] = [];
      for (let i = 0; i < n; i++) {
        const t = 1 + rnd(5);
        facts.push({
          orgId: asOrgId(rnd(10) === 0 ? pick(orgs) : org),
          srcQualifiedName: asQualifiedName(pick(srcs)),
          dstQualifiedName: asQualifiedName(pick(dsts)),
          relType: pick(rels) as EdgeFact["relType"],
          attributes: pick(attrs),
          firstSeenAt: t,
          lastSeenAt: t + rnd(3),
        });
        // Same key again in the batch, sometimes with other attributes.
        if (rnd(4) === 0) {
          const prev = facts[facts.length - 1] as EdgeFact;
          facts.push({ ...prev, attributes: pick(attrs), lastSeenAt: prev.lastSeenAt + rnd(3) });
        }
      }
      const reconcile = rnd(4) !== 0;
      const extras = reconcile && rnd(3) === 0 ? { org, qnames: [pick(srcs), pick(srcs)] } : null;
      const got = store.mergeEdges(facts, {
        reconcileSources: reconcile,
        ...(extras
          ? { reconcileExtraSrcs: { orgId: asOrgId(extras.org), qnames: extras.qnames } }
          : {}),
      });
      const want = model.merge(facts, reconcile, extras);
      expect(got).toEqual(
        reconcile
          ? want
          : { inserted: want.inserted, updated: want.updated, unchanged: want.unchanged },
      );
      expect(dump(store)).toEqual(model.rows);
    }
    expect(model.rows.size).toBeGreaterThan(10);
    await store.close();
  });
});
