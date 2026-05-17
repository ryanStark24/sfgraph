import { describe, expect, it } from "vitest";
import { ApexClassParser } from "../index.js";
import { makeTestCtx } from "../../__tests__/_harness.js";

async function parse(body: string) {
  return new ApexClassParser().parse(
    { className: "Sample", body, metaXml: "<ApexClass/>" },
    makeTestCtx(),
  );
}

describe("W1-05: IS_TEST attribute on Apex class / method nodes", () => {
  it("class with @isTest annotation: class node has isTest=true; static methods inherit", async () => {
    const result = await parse(`
      @isTest
      public class SampleTest {
        @isTest static void testOne() {}
        static void helper() {}
      }
    `);

    const cls = result.nodes.find((n) => String(n.qualifiedName) === "ApexClass:SampleTest");
    expect(cls?.attributes.isTest).toBe(true);

    // Both methods inherit isTest from class @isTest + static
    const testOne = result.nodes.find(
      (n) => String(n.qualifiedName).startsWith("ApexMethod:SampleTest.testOne") || String(n.qualifiedName).startsWith("ApexMethod:SampleTest.testOne") || String(n.qualifiedName).includes("SampleTest.testOne"),
    );
    expect(testOne?.label).toBe("TestMethod");
    expect(testOne?.attributes.isTest).toBe(true);

    const helper = result.nodes.find((n) => String(n.qualifiedName).includes("SampleTest.helper"));
    expect(helper?.label).toBe("TestMethod"); // static method in @isTest class
    expect(helper?.attributes.isTest).toBe(true);
  });

  it("plain class with @isTest only on a single method: only that method is a test", async () => {
    const result = await parse(`
      public class Mixed {
        @isTest static void onlyThisOne() {}
        public void normalMethod() {}
      }
    `);

    const cls = result.nodes.find((n) => String(n.qualifiedName) === "ApexClass:Mixed");
    expect(cls?.attributes.isTest).toBe(false);

    const test = result.nodes.find((n) => String(n.qualifiedName).includes("Mixed.onlyThisOne"));
    expect(test?.label).toBe("TestMethod");
    expect(test?.attributes.isTest).toBe(true);

    const normal = result.nodes.find((n) =>
      String(n.qualifiedName).includes("Mixed.normalMethod"),
    );
    expect(normal?.label).toBe("ApexMethod");
    expect(normal?.attributes.isTest).toBe(false);
  });

  it("@TestSetup methods are flagged as tests", async () => {
    const result = await parse(`
      @isTest
      public class WithSetup {
        @TestSetup static void seed() {}
      }
    `);
    const setup = result.nodes.find((n) => String(n.qualifiedName).includes("WithSetup.seed"));
    expect(setup?.label).toBe("TestMethod");
    expect(setup?.attributes.isTest).toBe(true);
  });
});
