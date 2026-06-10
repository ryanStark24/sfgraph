import { describe, expect, it } from "vitest";
import { makeTestCtx } from "../../__tests__/_harness.js";
import { ApexClassParser } from "../index.js";

/**
 * Regression for the Tier-2 blocker: governor in-loop detection produced ZERO
 * findings on a real org because `inLoop` was stamped only by the AST extractor
 * (SFGRAPH_APEX_PARSER=ast), while the DEFAULT parser mode is regex. These
 * tests drive the regex path (no env override) and assert it now stamps
 * `inLoop` on EXECUTES_SOQL / EXECUTES_DML inside loops, and NOT outside —
 * which is exactly what populateGovernorRisks reads.
 */
async function soqlDmlEdges(body: string) {
  const result = await new ApexClassParser().parse(
    { className: "Gov", body, metaXml: "<ApexClass/>" },
    makeTestCtx(),
  );
  return result.edges
    .filter((e) => e.relType === "EXECUTES_SOQL" || e.relType === "EXECUTES_DML")
    .map((e) => ({
      rel: e.relType,
      dst: String(e.dstQualifiedName),
      inLoop: (e.attributes as { inLoop?: boolean }).inLoop === true,
    }));
}

describe("regex-mode governor inLoop stamping (default parser path)", () => {
  it("stamps inLoop on SOQL inside a for-loop, not on SOQL outside", async () => {
    const edges = await soqlDmlEdges(`
      public class Gov {
        public void run() {
          List<Account> outside = [SELECT Id FROM Account LIMIT 1];
          for (Integer i = 0; i < 10; i++) {
            Account a = [SELECT Id FROM Contact WHERE Id = :i];
          }
        }
      }
    `);
    const acct = edges.find((e) => e.dst === "CustomObject:Account");
    const cont = edges.find((e) => e.dst === "CustomObject:Contact");
    expect(acct?.inLoop).toBe(false);
    expect(cont?.inLoop).toBe(true);
  });

  it("stamps inLoop on DML inside a while-loop", async () => {
    const edges = await soqlDmlEdges(`
      public class Gov {
        public void run() {
          Integer i = 0;
          while (i < 5) {
            Account a = new Account();
            update a;
            i++;
          }
        }
      }
    `);
    const dml = edges.find((e) => e.rel === "EXECUTES_DML");
    expect(dml?.inLoop).toBe(true);
  });

  it("does NOT flag a for-each header query (runs once, not in-loop)", async () => {
    const edges = await soqlDmlEdges(`
      public class Gov {
        public void run() {
          for (Account a : [SELECT Id FROM Account]) {
            a.Name = 'x';
          }
        }
      }
    `);
    const acct = edges.find((e) => e.dst === "CustomObject:Account");
    // The query is the loop SOURCE — executed once — so it must NOT be inLoop.
    expect(acct?.inLoop).toBe(false);
  });
});
