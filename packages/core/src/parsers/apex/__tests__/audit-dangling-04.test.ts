import { describe, expect, it } from "vitest";
import { makeTestCtx } from "../../__tests__/_harness.js";
import { ApexClassParser } from "../index.js";

/**
 * Audit dangling-04: IS_TEST_FOR is scraped from every `new X(` / `X.m(`
 * in a test class, so it targets system types and SObjects.
 */
describe("audit dangling-04: IS_TEST_FOR targets only user classes", () => {
  it("does not emit IS_TEST_FOR to Database, System, String, Test or SObjects", async () => {
    const result = await new ApexClassParser().parse(
      {
        className: "FooServiceTest",
        metaXml: "<ApexClass/>",
        body: `
        @isTest
        private class FooServiceTest {
          @isTest static void run() {
            Account a = new Account(Name = 'x');
            Database.insert(a);
            Test.startTest();
            String s = String.valueOf(1);
            System.assertEquals(1, 1);
            FooService.doWork(a.Id);
            Test.stopTest();
          }
        }
      `,
      },
      makeTestCtx(),
    );
    const targets = result.edges
      .filter((e) => e.relType === "IS_TEST_FOR")
      .map((e) => String(e.dstQualifiedName));
    expect(targets).toContain("ApexClass:FooService");
    for (const bogus of ["Database", "System", "String", "Test", "Account"]) {
      expect(targets).not.toContain(`ApexClass:${bogus}`);
    }
  });
});
