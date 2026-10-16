import { asOrgId, asQualifiedName, asSha256 } from "@ryanstark24/sfgraph-shared";
import { describe, expect, it } from "vitest";
import type { NodeFact } from "../../domain/index.js";
import { SqliteGraphStore } from "../../storage/sqlite/graph-store.js";
import { MAX_GLOB_PATTERN_LENGTH, compileGlob, findNodesByGlob } from "../find-nodes.js";

// audit sec-02: a pathological glob must not block the event loop. It either
// finishes in < 500 ms or is rejected with a clear error.
const ORG = asOrgId("org_sec02");
// 8 lazy `*?` pairs over 40 short qnames takes ~3 s today (each extra pair
// multiplies the cost ~3-4x); a linear matcher or a length/wildcard cap
// keeps it well under 500 ms.
const PAIRS = 8;
const NODES = 40;

describe("audit sec-02: find_nodes ReDoS", () => {
  it("pathological '*?' pattern is fast or rejected", async () => {
    const store = new SqliteGraphStore({ dbPath: ":memory:" });
    await store.init();
    const nodes: NodeFact[] = [];
    for (let i = 0; i < NODES; i++) {
      const qname = `ApexClass:${"A".repeat(30)}${i}`;
      nodes.push({
        orgId: ORG,
        qualifiedName: asQualifiedName(qname),
        label: "ApexClass",
        attributes: {},
        sourceHash: asSha256(qname),
        firstSeenAt: 1,
        lastSeenAt: 1,
        lastModifiedAt: 1,
      });
    }
    store.mergeNodes(nodes);
    const pattern = `ApexClass:${"*?".repeat(PAIRS)}!`;
    const t0 = performance.now();
    let err: unknown;
    try {
      findNodesByGlob(store, ORG, pattern, { label: "ApexClass" });
    } catch (e) {
      err = e;
    }
    const ms = performance.now() - t0;
    await store.close();
    if (err) {
      expect(String((err as Error).message)).toMatch(/pattern|wildcard|glob/i);
    } else {
      expect(ms).toBeLessThan(500);
    }
  });
});

describe("audit sec-02: linear glob matcher", () => {
  it("stays fast on many wildcard runs over long names", () => {
    const m = compileGlob(`ApexClass:${"*?".repeat(40)}!`);
    const text = `ApexClass:${"A".repeat(2000)}`;
    const t0 = performance.now();
    for (let i = 0; i < 200; i++) expect(m(text)).toBe(false);
    expect(performance.now() - t0).toBeLessThan(500);
  });

  it("rejects brace patterns with too many alternatives", () => {
    expect(() => compileGlob("{a,b}{a,b}{a,b}{a,b}{a,b}{a,b}{a,b}{a,b}{a,b}")).toThrow(/glob/);
  });

  it("keeps the glob vocabulary", () => {
    expect(compileGlob("Flow:{Lead,Acc{ount,t}}_*")("Flow:Acct_X")).toBe(true);
    expect(compileGlob("ApexClass:[a-c]?x")("ApexClass:Bzx")).toBe(true);
    expect(compileGlob("ApexClass:[!a-c]?x")("ApexClass:Bzx")).toBe(false);
    expect(compileGlob("CustomField:Account.\\*")("CustomField:Account.*")).toBe(true);
    expect(compileGlob("CustomField:Account.\\*")("CustomField:Account.Name")).toBe(false);
    expect(compileGlob("Report:*")("Report:Folder/Name")).toBe(true);
    expect(compileGlob("CustomField:**.*Email*")("CustomField:Contact.Work_Email__c")).toBe(true);
  });
});

// Review I-1: brace expansion multiplied the per-alternative matcher; these
// schema-legal patterns took 3.5-8 s over 40k qnames.
describe("audit sec-02: pathological brace patterns over 40k names", () => {
  const names: string[] = [];
  for (let i = 0; i < 40_000; i++) {
    names.push(`CustomField:Object_${i % 900}__c.Some_Field_Name_${i}_x__c`);
  }
  const patterns = [
    `${"{,}".repeat(8)}*_*_*_*${"_?".repeat(40)}!`,
    `${"{,}".repeat(8)}*${"?".repeat(100)}!`,
    `${"{a,b}".repeat(6)}*${"?".repeat(20)}!`,
    "*{a*,*b}{c*,*d}{e*,*f}*_*_*_*!",
    `${"*?".repeat(200)}!`,
  ];
  for (const pattern of patterns) {
    it(`scans 40k names in ~200 ms: ${pattern.slice(0, 40)}`, () => {
      const t0 = performance.now();
      const m = compileGlob(pattern);
      let hits = 0;
      for (const n of names) if (m(n)) hits++;
      const ms = performance.now() - t0;
      expect(hits).toBe(0);
      expect(ms).toBeLessThan(300);
    });
  }

  it("still finds real matches at that scale", () => {
    const m = compileGlob("{,}{,}CustomField:Object_1{0,1}__c.*_x__c");
    expect(names.filter(m).length).toBe(2 * Math.ceil(40_000 / 900));
  });
});

describe("audit sec-02: glob limits and braces", () => {
  it("deduplicates expansions before the cap", () => {
    expect(() => compileGlob(`${"{,}".repeat(40)}x`)).not.toThrow();
    expect(compileGlob(`${"{,}".repeat(40)}x`)("X")).toBe(true);
  });

  it("caps distinct expansions at 64", () => {
    expect(() => compileGlob("{a,b}{a,b}{a,b}{a,b}{a,b}{a,b}")).not.toThrow();
    expect(() => compileGlob("{a,b}{a,b}{a,b}{a,b}{a,b}{a,b}{a,b}")).toThrow(/64 distinct/);
  });

  it("rejects patterns longer than the length cap", () => {
    expect(() => compileGlob("a".repeat(MAX_GLOB_PATTERN_LENGTH))).not.toThrow();
    expect(() => compileGlob("a".repeat(MAX_GLOB_PATTERN_LENGTH + 1))).toThrow(/longer than 512/);
  });

  it("expands braces nested inside a literal {a} group (review M-4)", () => {
    const m = compileGlob("X{a{b,c}}");
    expect(m("X{ab}")).toBe(true);
    expect(m("X{ac}")).toBe(true);
    expect(m("Xab")).toBe(false);
    expect(compileGlob("X{a}")("X{a}")).toBe(true);
    expect(compileGlob("X{a,b")("X{a,b")).toBe(true);
    expect(compileGlob("A{[,],b}")("A,")).toBe(true);
  });
});

describe("audit sec-02: DFA blow-up is bounded", () => {
  it("an exponential-state pattern over 40k random names is fast or rejected", () => {
    const names: string[] = [];
    let seed = 7;
    for (let i = 0; i < 40_000; i++) {
      let s = "";
      for (let j = 0; j < 60; j++) {
        seed = (seed * 1103515245 + 12345) & 0x7fffffff;
        s += (seed >> 16) & 1 ? "a" : "b";
      }
      names.push(s);
    }
    const t0 = performance.now();
    let err: unknown;
    try {
      const m = compileGlob(`*a${"?".repeat(40)}b`);
      for (const n of names) m(n);
    } catch (e) {
      err = e;
    }
    const ms = performance.now() - t0;
    if (err) expect(String((err as Error).message)).toMatch(/too complex/);
    expect(ms).toBeLessThan(400);
  });
});
