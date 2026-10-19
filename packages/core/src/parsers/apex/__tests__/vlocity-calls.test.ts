import { describe, expect, it } from "vitest";
import { makeTestCtx } from "../../__tests__/_harness.js";
import { ApexClassParser } from "../index.js";
import { extractVlocityCalls, extractVlocityDispatch } from "../vlocity-calls.js";

describe("extractVlocityCalls", () => {
  it("literal, local constant, dynamic", () => {
    const body = `
      Object a = vlocity_cmt.IntegrationProcedureService.runIntegrationService('Order_BundleStep', input, null);
      String k = 'Shop_Checkout';
      Object b = IntegrationProcedureService.runIntegrationService(k, input, null);
      Object c = vlocity_cmt.IntegrationProcedureService.runIntegrationService(autoMethodName, input, null);
      // vlocity_cmt.IntegrationProcedureService.runIntegrationService('Commented_Out', i, o);
      vlocity_cmt.DRProcessResult r = vlocity_cmt.DRGlobal.process(drinputMap, 'DRUpdateOrderAttributes');`;
    expect(extractVlocityCalls(body)).toEqual({
      ipKeys: ["Order_BundleStep", "Shop_Checkout"],
      drNames: ["DRUpdateOrderAttributes"],
      unresolved: 1,
    });
  });
});

describe("extractVlocityDispatch", () => {
  const cls = `global class H implements vlocity_cmt.VlocityOpenInterface {
    global Boolean invokeMethod(String methodName, Map<String,Object> i, Map<String,Object> o, Map<String,Object> opt) {
      if ('swichOffAll'.equalsIgnoreCase(methodName)) { o.put('result', swichOffAll()); return true; }
      else if (methodName == 'getA') { return this.getA(i, o); }
      else if (methodName.equals('noCall')) { return true; }
      switch on methodName { when 'x', 'y' { doXY(i); } }
      return false;
    } }`;
  it("builds a lowercased key → callee map", () => {
    expect(extractVlocityDispatch(cls, ["vlocity_cmt.VlocityOpenInterface"])).toEqual({
      swichoffall: "swichOffAll",
      geta: "getA",
      x: "doXY",
      y: "doXY",
    });
  });
  it("non-implementing class → null", () => {
    expect(extractVlocityDispatch(cls, ["Queueable"])).toBeNull();
  });
});

describe("ApexClassParser wiring", () => {
  it("emits APEX_CALLS_IP / APEX_CALLS_DR edges and vlocityDispatch attribute", async () => {
    const body = `global class Caller implements vlocity_cmt.VlocityOpenInterface {
      global Boolean invokeMethod(String m, Map<String,Object> i, Map<String,Object> o, Map<String,Object> opt) {
        if (m == 'go') { return run(i); }
        return false;
      }
      public Object run(Object input) {
        vlocity_cmt.DRGlobal.process(input, 'DRFoo');
        return vlocity_cmt.IntegrationProcedureService.runIntegrationService('Type_Sub', input, null);
      }
    }`;
    const r = await new ApexClassParser().parse(
      { className: "Caller", body, metaXml: "<ApexClass/>" },
      makeTestCtx(),
    );
    const ip = r.edges.filter((e) => e.relType === "APEX_CALLS_IP");
    const dr = r.edges.filter((e) => e.relType === "APEX_CALLS_DR");
    expect(ip.map((e) => String(e.dstQualifiedName))).toEqual(["IntegrationProcedure:Type_Sub"]);
    expect(String(ip[0]?.srcQualifiedName)).toMatch(/^ApexMethod:Caller\.run\(1\)$/);
    expect(dr.map((e) => String(e.dstQualifiedName))).toEqual(["DataRaptor:DRFoo"]);
    const cls = r.nodes.find((n) => String(n.qualifiedName) === "ApexClass:Caller");
    expect(cls?.attributes.vlocityDispatch).toEqual({ go: "run" });
  });
  it("plain class has no vlocityDispatch attribute", async () => {
    const r = await new ApexClassParser().parse(
      { className: "P", body: "public class P { public void a() {} }", metaXml: "<ApexClass/>" },
      makeTestCtx(),
    );
    const cls = r.nodes.find((n) => String(n.qualifiedName) === "ApexClass:P");
    expect(cls?.attributes).not.toHaveProperty("vlocityDispatch");
  });
});

describe("ApexClassParser wiring: call-site name before declaration", () => {
  it("finds the IP call in the declared method even if an earlier method calls it by name", async () => {
    const body = `global class C {
      global Object invokeMethod(String m) { return upd(m); }
      private Boolean upd(String x) {
        vlocity_cmt.DRGlobal.process(x, 'DRLate');
        return true;
      }
    }`;
    const r = await new ApexClassParser().parse(
      { className: "C", body, metaXml: "<ApexClass/>" },
      makeTestCtx(),
    );
    const dr = r.edges.filter((e) => e.relType === "APEX_CALLS_DR");
    expect(dr.map((e) => `${e.srcQualifiedName}->${e.dstQualifiedName}`)).toEqual([
      "ApexMethod:C.upd(1)->DataRaptor:DRLate",
    ]);
  });
});

describe("ApexClassParser wiring: declaration lookup ignores comments/strings", () => {
  const run = async (body: string) => {
    const r = await new ApexClassParser().parse(
      { className: "C", body, metaXml: "<ApexClass/>" },
      makeTestCtx(),
    );
    return r.edges
      .filter((e) => e.relType === "APEX_CALLS_DR" || e.relType === "APEX_CALLS_IP")
      .map((e) => `${e.srcQualifiedName}->${e.dstQualifiedName}`)
      .sort();
  };
  it("commented-out declaration before the real one", async () => {
    expect(
      await run(`global class C {
        // private Boolean upd(String x) { vlocity_cmt.DRGlobal.process(x, 'DRWrong');
        /* private Boolean upd(String x) { */
        private Boolean upd(String x) { vlocity_cmt.DRGlobal.process(x, 'DRRight'); return true; }
      }`),
    ).toEqual(["ApexMethod:C.upd(1)->DataRaptor:DRRight"]);
  });
  it("same-name overloads of different arity get their own bodies", async () => {
    expect(
      await run(`global class C {
        public void go(String a) { vlocity_cmt.DRGlobal.process(a, 'DROne'); }
        public void go(String a, String b) { vlocity_cmt.DRGlobal.process(a, 'DRTwo'); }
      }`),
    ).toEqual(["ApexMethod:C.go(1)->DataRaptor:DROne", "ApexMethod:C.go(2)->DataRaptor:DRTwo"]);
  });
  it("braces inside a string literal and a comment do not break body matching", async () => {
    expect(
      await run(`global class C {
        public void a(String x) {
          String s = '{';
          // }
          vlocity_cmt.DRGlobal.process(x, 'DRBraces');
        }
      }`),
    ).toEqual(["ApexMethod:C.a(1)->DataRaptor:DRBraces"]);
  });
});

describe("extractVlocityDispatch: constructor calls are not callees", () => {
  it("skips new Foo(", () => {
    const cls = `class H implements VlocityOpenInterface {
      Boolean invokeMethod(String m, Map<String,Object> i, Map<String,Object> o, Map<String,Object> p) {
        if (m == 'k') { Foo f = new Foo(); return real(i); }
        return false; } }`;
    expect(extractVlocityDispatch(cls, ["VlocityOpenInterface"])).toEqual({ k: "real" });
  });
});

describe("class-level String constants as IP / DataRaptor names (cycle 2 T3)", () => {
  const run = async (body: string) => {
    const r = await new ApexClassParser().parse(
      { className: "Svc", body, metaXml: "<ApexClass/>" },
      makeTestCtx(),
    );
    return r.edges
      .filter((e) => e.relType === "APEX_CALLS_DR" || e.relType === "APEX_CALLS_IP")
      .map((e) => `${e.srcQualifiedName}->${e.dstQualifiedName}`)
      .sort();
  };
  it("resolves a final String field passed by name", async () => {
    expect(
      await run(`public class Svc {
        private static final String IP_KEY = 'Type_SubType';
        public static final String DR_NAME='DRLoadThing';
        public void go(Map<String, Object> input) {
          vlocity_cmt.IntegrationProcedureService.runIntegrationService(IP_KEY, input, null);
          vlocity_cmt.DRGlobal.process(input, DR_NAME);
        }
      }`),
    ).toEqual([
      "ApexMethod:Svc.go(1)->DataRaptor:DRLoadThing",
      "ApexMethod:Svc.go(1)->IntegrationProcedure:Type_SubType",
    ]);
  });
  it("matches the constant name case-insensitively, as Apex does", async () => {
    expect(
      await run(`public class Svc {
        static final String Ip_Key = 'Type_SubType';
        public void go(Object input) {
          vlocity_cmt.IntegrationProcedureService.runIntegrationService(IP_KEY, input, null);
        }
      }`),
    ).toEqual(["ApexMethod:Svc.go(1)->IntegrationProcedure:Type_SubType"]);
  });
  it("a local assignment in the method wins over the class constant", async () => {
    expect(
      await run(`public class Svc {
        private static final String K = 'Type_Class';
        public void go(Object input) {
          String K = 'Type_Local';
          vlocity_cmt.IntegrationProcedureService.runIntegrationService(K, input, null);
        }
      }`),
    ).toEqual(["ApexMethod:Svc.go(1)->IntegrationProcedure:Type_Local"]);
  });
  it("matches a local assignment case-insensitively, as Apex does (T3 fix 1 M-3)", async () => {
    expect(
      await run(`public class Svc {
        private static final String K = 'Type_Class';
        public void go(Object input) {
          string ipName = 'Type_Local';
          vlocity_cmt.IntegrationProcedureService.runIntegrationService(IPNAME, input, null);
          vlocity_cmt.IntegrationProcedureService.runIntegrationService(k, input, null);
        }
      }`),
    ).toEqual([
      "ApexMethod:Svc.go(1)->IntegrationProcedure:Type_Class",
      "ApexMethod:Svc.go(1)->IntegrationProcedure:Type_Local",
    ]);
  });
  it("a parameter or local declared with the same name shadows the constant", async () => {
    expect(
      await run(`public class Svc {
        private static final String K = 'Type_Class';
        public void go(String k, Object input) {
          vlocity_cmt.IntegrationProcedureService.runIntegrationService(k, input, null);
        }
        public void other(Object input) {
          String K;
          K = pick();
          vlocity_cmt.IntegrationProcedureService.runIntegrationService(K, input, null);
        }
      }`),
    ).toEqual([]);
  });
  it("a non-final field, or a name with two different constant values, stays unresolved", async () => {
    expect(
      await run(`public class Svc {
        private static String MUTABLE = 'Type_Mutable';
        public class A { private final String DUP = 'Type_One'; }
        public class B { private final String DUP = 'Type_Two'; }
        public void go(Object input) {
          vlocity_cmt.IntegrationProcedureService.runIntegrationService(MUTABLE, input, null);
          vlocity_cmt.IntegrationProcedureService.runIntegrationService(DUP, input, null);
        }
      }`),
    ).toEqual([]);
  });
  it("a final local in another method is not a class constant", async () => {
    expect(
      await run(`public class Svc {
        public void setup() { final String K = 'Type_Local'; }
        public void go(Object input) {
          vlocity_cmt.IntegrationProcedureService.runIntegrationService(K, input, null);
        }
      }`),
    ).toEqual([]);
  });
  it("a constant mentioned only in a comment is not a constant", async () => {
    expect(
      await run(`public class Svc {
        // private static final String K = 'Type_Commented';
        public void go(Object input) {
          vlocity_cmt.IntegrationProcedureService.runIntegrationService(K, input, null);
        }
      }`),
    ).toEqual([]);
  });
});
