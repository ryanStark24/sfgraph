import { describe, expect, it } from "vitest";
import { makeTestCtx } from "../../__tests__/_harness.js";
import { ApexClassParser } from "../class.js";

/**
 * A method with NO explicit access modifier is implicitly private in Apex and
 * is a real method. The extractor's method regex used to REQUIRE a modifier
 * (`+`), silently dropping every unmodified helper/inner-class method. These
 * assert those methods now surface as ApexMethod nodes, while control flow that
 * merely looks like a method header (`else if (x) {`) is NOT mistaken for one.
 */
async function methodNames(body: string): Promise<string[]> {
  const result = await new ApexClassParser().parse({ className: "Svc", body }, makeTestCtx());
  return result.nodes
    .filter((n) => n.label === "ApexMethod" || n.label === "TestMethod")
    .map((n) => String(n.qualifiedName));
}

describe("ApexClassParser — implicit-private methods", () => {
  it("captures a method with no access modifier", async () => {
    const body = `public class Svc {
      String buildKey(Id recordId) {
        return 'k-' + recordId;
      }
      public void run() {
        String k = buildKey(null);
      }
    }`;
    const names = await methodNames(body);
    // Both the implicitly-private helper and the explicit method are present.
    expect(names).toContain("ApexMethod:Svc.buildKey(1)");
    expect(names).toContain("ApexMethod:Svc.run(0)");
  });

  it("does not capture a constructor as a phantom method (N3 regression)", async () => {
    const body = `public class Account_Service {
      public Account_Service(String a, Integer b) {
        this.a = a;
      }
      private Account_Service() {}
      String realHelper() { return 'x'; }
    }`;
    const result = await new ApexClassParser().parse(
      { className: "Account_Service", body },
      makeTestCtx(),
    );
    const names = result.nodes
      .filter((n) => n.label === "ApexMethod" || n.label === "TestMethod")
      .map((n) => String(n.qualifiedName));
    // No phantom ApexMethod:Account_Service.Account_Service(...) from the ctors.
    expect(names.some((n) => /\.Account_Service\(/.test(n))).toBe(false);
    // The real implicit-private method is still captured.
    expect(names).toContain("ApexMethod:Account_Service.realHelper(0)");
  });

  it("does not invent a method from `else if (x) {` control flow", async () => {
    const body = `public class Svc {
      public void run(Integer x) {
        if (x > 0) {
          System.debug('pos');
        } else if (x < 0) {
          System.debug('neg');
        }
      }
    }`;
    const names = await methodNames(body);
    expect(names).toContain("ApexMethod:Svc.run(1)");
    // No phantom method named "if" / "else".
    expect(names.some((n) => /\.(if|else|for|while|catch)\(/i.test(n))).toBe(false);
  });
});
