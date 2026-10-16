import { describe, expect, it } from "vitest";
import { makeTestCtx } from "../../__tests__/_harness.js";
import { ApexClassParser } from "../class.js";
import { ApexTriggerParser } from "../trigger.js";

/**
 * CALLS edges for instance and same-class calls (regex path). The receiver's
 * declared type (local, parameter, enclosing-class field / property) picks the
 * class; the target has the same `ApexMethod:<Class>.<name>(<arity>)` shape
 * the static-call rule emits. An unresolvable receiver emits nothing.
 */
type Edge = {
  relType: string;
  srcQualifiedName: unknown;
  dstQualifiedName: unknown;
  attributes: Record<string, unknown>;
};

const calls = (edges: Edge[], src: string): string[] =>
  edges
    .filter((e) => e.relType === "CALLS" && String(e.srcQualifiedName) === src)
    .map((e) => String(e.dstQualifiedName))
    .sort();

async function parse(className: string, body: string): Promise<Edge[]> {
  const r = await new ApexClassParser().parse({ className, body }, makeTestCtx());
  return r.edges as unknown as Edge[];
}

describe("instance calls on typed receivers", () => {
  it("links a call on a typed local, a parameter and a class field", async () => {
    const edges = await parse(
      "Caller",
      `public class Caller {
        private AccountService fieldSvc;
        public static OrderService StaticSvc = new OrderService();
        public void run(InvoiceService param) {
          AccountService svc = new AccountService();
          svc.process();
          svc.process(1, 'x');
          param.bill(2);
          fieldSvc.sync();
          this.fieldSvc.flush();
          StaticSvc.send();
        }
      }`,
    );
    expect(calls(edges, "ApexMethod:Caller.run(1)")).toEqual([
      "ApexMethod:AccountService.flush(0)",
      "ApexMethod:AccountService.process(0)",
      "ApexMethod:AccountService.process(2)",
      "ApexMethod:AccountService.sync(0)",
      "ApexMethod:InvoiceService.bill(1)",
      "ApexMethod:OrderService.send(0)",
    ]);
    const e = edges.find(
      (x) => String(x.dstQualifiedName) === "ApexMethod:AccountService.process(2)",
    );
    expect(e?.attributes.callResolution).toBe("receiver-type");
    expect(e?.attributes.arity).toBe(2);
  });

  it("links `new Foo().bar()`", async () => {
    const edges = await parse(
      "Caller",
      `public class Caller {
        public void run() {
          new AccountService().process(new List<Account>());
          new AccountService(1, 2).finish();
        }
      }`,
    );
    expect(calls(edges, "ApexMethod:Caller.run(0)")).toEqual([
      "ApexMethod:AccountService.finish(0)",
      "ApexMethod:AccountService.process(1)",
    ]);
  });

  it("emits nothing for an unresolvable or non-class receiver", async () => {
    const edges = await parse(
      "Caller",
      `public class Caller {
        public void run(Map<Id, AccountService> byId, List<AccountService> all) {
          undeclared.process();
          byId.get(null).process();
          all.add(null);
          String s = 'x';
          s.toUpperCase();
          Account a = new Account();
          a.put('Name', 'x');
          Database.SaveResult sr = null;
          sr.isSuccess();
          getSvc().process();
        }
      }`,
    );
    expect(calls(edges, "ApexMethod:Caller.run(2)")).toEqual([]);
  });

  it("a local shadowing a class name resolves by the local's declared type", async () => {
    const edges = await parse(
      "Caller",
      `public class Caller {
        public void run() {
          AccountService Helper = new AccountService();
          Helper.process();
          String Logger = 'x';
          Logger.toUpperCase();
        }
      }`,
    );
    // `Helper` / `Logger` are variables, not classes: no ApexMethod:Helper.* or Logger.*.
    expect(calls(edges, "ApexMethod:Caller.run(0)")).toEqual([
      "ApexMethod:AccountService.process(0)",
    ]);
  });

  it("a local declared after the call does not type an earlier receiver", async () => {
    const edges = await parse(
      "Caller",
      `public class Caller {
        public void run() {
          svc.process();
          AccountService svc = new AccountService();
        }
      }`,
    );
    expect(calls(edges, "ApexMethod:Caller.run(0)")).toEqual([]);
  });
});

describe("same-class, this. and super. calls", () => {
  it("links unqualified and this. calls to methods declared in the file", async () => {
    const edges = await parse(
      "Worker",
      `public class Worker {
        public void run() {
          helper();
          helper(1);
          this.helper(2, 3);
          Helper(4);
          notDeclaredHere();
          if (check()) { }
        }
        private void helper() { }
        private void helper(Integer a) { }
        private void helper(Integer a, Integer b) { }
        private Boolean check() { return true; }
      }`,
    );
    expect(calls(edges, "ApexMethod:Worker.run(0)")).toEqual([
      "ApexMethod:Worker.check(0)",
      "ApexMethod:Worker.helper(0)",
      "ApexMethod:Worker.helper(1)",
      "ApexMethod:Worker.helper(2)",
    ]);
  });

  it("does not take a method declaration, a constructor call or a keyword for a call", async () => {
    const edges = await parse(
      "Worker",
      `public class Worker {
        public Worker() { this(1); }
        public Worker(Integer x) { super(); }
        public void run() {
          for (Integer i = 0; i < 2; i++) { }
          while (false) { }
          Worker w = new Worker();
        }
      }`,
    );
    expect(calls(edges, "ApexMethod:Worker.run(0)")).toEqual([]);
  });

  it("links super.method() to the parent class", async () => {
    const edges = await parse(
      "Child",
      `public class Child extends BaseHandler {
        public override void handle(Integer x) {
          super.handle(x);
          super.beforeAll();
        }
      }`,
    );
    expect(calls(edges, "ApexMethod:Child.handle(1)")).toEqual([
      "ApexMethod:BaseHandler.beforeAll(0)",
      "ApexMethod:BaseHandler.handle(1)",
    ]);
  });

  it("super.method() without an extends clause emits nothing", async () => {
    const edges = await parse(
      "Solo",
      `public class Solo {
        public override String toString() { return super.toString(); }
      }`,
    );
    expect(calls(edges, "ApexMethod:Solo.toString(0)")).toEqual([]);
  });

  it("a receiver typed by an inner class links to the file's own method qname", async () => {
    const edges = await parse(
      "Outer",
      `public class Outer {
        public void run() {
          Inner i = new Inner();
          i.go(1);
          Outer.Inner j = new Outer.Inner();
          j.go(2);
        }
        public class Inner {
          public void go(Integer n) { }
        }
      }`,
    );
    expect(calls(edges, "ApexMethod:Outer.run(0)")).toEqual(["ApexMethod:Outer.go(1)"]);
  });
});

describe("instance calls in triggers", () => {
  it("links calls on typed locals in a trigger body", async () => {
    const r = await new ApexTriggerParser().parse(
      {
        triggerName: "AccTrg",
        body: `trigger AccTrg on Account (after insert) {
          AccountTriggerHandler h = new AccountTriggerHandler();
          h.afterInsert(Trigger.new);
          new OtherHandler().run();
        }`,
      },
      makeTestCtx(),
    );
    expect(calls(r.edges as unknown as Edge[], "ApexTrigger:AccTrg")).toEqual([
      "ApexMethod:AccountTriggerHandler.afterInsert(1)",
      "ApexMethod:OtherHandler.run(0)",
    ]);
  });
});
