import { describe, expect, it } from "vitest";
import { makeTestCtx } from "../../__tests__/_harness.js";
import { ApexClassParser } from "../index.js";

/**
 * Review M-6: the set of declared variable names that suppresses static-call
 * receivers was file-wide, so `String Helper` declared in one method hid a
 * real `Helper.run()` call in another.
 */
describe("review M-6: local variables are scoped per method", () => {
  it("a variable in one method does not hide a static call in another", async () => {
    const result = await new ApexClassParser().parse(
      {
        className: "Svc",
        metaXml: "<ApexClass/>",
        body: `
      public class Svc {
        public void a() { String Helper = 'x'; Helper.length(); }
        public void b() { Helper.run(); }
      }`,
      },
      makeTestCtx(),
    );
    const calls = (src: string) =>
      result.edges
        .filter((e) => e.relType === "CALLS" && String(e.srcQualifiedName) === src)
        .map((e) => String(e.dstQualifiedName));
    expect(calls("ApexMethod:Svc.b(0)")).toContain("ApexMethod:Helper.run(0)");
    expect(calls("ApexMethod:Svc.a(0)").filter((d) => d.startsWith("ApexMethod:Helper."))).toEqual(
      [],
    );
  });

  it("review N-1: inner-class methods still see the outer class's static fields", async () => {
    const result = await new ApexClassParser().parse(
      {
        className: "Svc",
        metaXml: "<ApexClass/>",
        body: `
      public class Svc {
        static Map<String, String> Cfg;
        public class Inner { public void m() { Cfg.get('a'); } }
      }`,
      },
      makeTestCtx(),
    );
    const dangling = result.edges
      .filter((e) => e.relType === "CALLS")
      .map((e) => String(e.dstQualifiedName))
      .filter((d) => d.startsWith("ApexMethod:Cfg."));
    expect(dangling).toEqual([]);
  });
});
