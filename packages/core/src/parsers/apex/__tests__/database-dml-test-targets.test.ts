import { describe, expect, it } from "vitest";
import { makeTestCtx } from "../../__tests__/_harness.js";
import { ApexClassParser } from "../class.js";
import { ApexTriggerParser } from "../trigger.js";

/**
 * Task 14 batch P, B5: `Database.<dml>(…)` calls are DML (any case), and
 * lowercase-initial test targets are kept as resolver candidates instead of
 * being dropped.
 */
type Edge = {
  relType: string;
  srcQualifiedName: unknown;
  dstQualifiedName: unknown;
  attributes?: Record<string, unknown>;
};

const dml = (edges: Edge[], src: string) =>
  edges
    .filter((e) => e.relType === "EXECUTES_DML" && String(e.srcQualifiedName) === src)
    .map((e) => ({
      dst: String(e.dstQualifiedName),
      target: e.attributes?.target,
      inLoop: e.attributes?.inLoop,
    }))
    .sort((a, b) => a.dst.localeCompare(b.dst));

describe("Database.<dml>() as DML (regex path)", () => {
  it("class methods: Database.insert / update(…, false) / INSERT, with inLoop", async () => {
    const body = `public class Batch {
      public void run(List<Case> cs, List<Account> accs) {
        Database.insert(cs);
        Database.update(accs, false);
        for (Integer i = 0; i < 2; i++) {
          Database.INSERT(cs, false);
        }
        database.Undelete(accs);
        Database.merge(accs[0], accs[1]);
        Database.Delete(accs);
        Database.upsert(cs, Case.Id, false);
        Database.query('SELECT Id FROM Case');
      }
    }`;
    const r = await new ApexClassParser().parse({ className: "Batch", body }, makeTestCtx());
    const got = dml(r.edges as unknown as Edge[], "ApexMethod:Batch.run(2)");
    expect(got.map((g) => g.dst)).toEqual([
      "DML:delete",
      "DML:insert",
      "DML:merge",
      "DML:undelete",
      "DML:update",
      "DML:upsert",
    ]);
    expect(got.find((g) => g.dst === "DML:insert")?.inLoop).toBe(true);
    expect(got.find((g) => g.dst === "DML:update")).toMatchObject({ target: "accs" });
    expect(got.find((g) => g.dst === "DML:update")?.inLoop).toBeUndefined();
  });

  it("trigger bodies: Database.update(…) is DML", async () => {
    const body = `trigger CaseTrg on Case (after insert) {
      List<Account> accs = new List<Account>();
      Database.update(accs, false);
    }`;
    const r = await new ApexTriggerParser().parse({ triggerName: "CaseTrg", body }, makeTestCtx());
    const got = dml(r.edges as unknown as Edge[], "ApexTrigger:CaseTrg");
    expect(got).toEqual([{ dst: "DML:update", target: "accs", inLoop: undefined }]);
  });
});

describe("IS_TEST_FOR: lowercase-initial targets", () => {
  it("keeps lowercase class references as resolver candidates, not edges", async () => {
    const body = `@isTest
    private class showProductTest {
      @isTest static void t() {
        showProductController c = new showProductController();
        Account acc = new Account();
        acc.save();
        Helper.run();
        utilHelper.go();
        System.assert(true);
      }
    }`;
    const r = await new ApexClassParser().parse(
      { className: "showProductTest", body },
      makeTestCtx(),
    );
    const edges = r.edges as unknown as Edge[];
    const testFor = edges
      .filter((e) => e.relType === "IS_TEST_FOR")
      .map((e) => String(e.dstQualifiedName))
      .sort();
    expect(testFor).toEqual(["ApexClass:Helper"]);
    const cls = r.nodes.find((n) => String(n.qualifiedName) === "ApexClass:showProductTest");
    expect((cls?.attributes as Record<string, unknown>).testTargetCandidates).toEqual([
      "showProductController",
      "utilHelper",
    ]);
  });

  it("non-test classes carry no candidates", async () => {
    const body = "public class Prod { public void x() { fooBar.go(); } }";
    const r = await new ApexClassParser().parse({ className: "Prod", body }, makeTestCtx());
    const cls = r.nodes.find((n) => String(n.qualifiedName) === "ApexClass:Prod");
    expect((cls?.attributes as Record<string, unknown>).testTargetCandidates).toBeUndefined();
  });
});
