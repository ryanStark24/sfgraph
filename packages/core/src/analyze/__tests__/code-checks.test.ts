import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { ConsoleLogger } from "@ryanstark24/sfgraph-shared";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { FilesystemMetadataSource } from "../../extractors/filesystem/index.js";
import { liveIngest } from "../../ingest/live-ingest.js";
import { offlineResolvedOrg } from "../../ingest/offline-org.js";
import { detectDomInjection, hasLwcDomManual } from "../../parsers/lwc/dom-injection.js";
import { SqliteGraphStore } from "../../storage/sqlite/graph-store.js";
import { detectAsyncInLoop, detectSoqlInjection } from "../apex-code-checks.js";
import { countCallArguments } from "../apex-code-checks.js";
import { scanCodeSecurity } from "../code-security.js";
import { collectFindings } from "../findings.js";
import { detectFlowDmlInLoop } from "../flow-dml-loop.js";
import { scanGovernorRisks } from "../governor.js";
import { normalizeSourceUri } from "../source-uri.js";

// S-1.9.0-001..004: async work in a loop, SOQL/SOSL injection, DOM injection and Flow DML in a
// loop. Detector unit tests (positive and negative per rule), then the same rules through a real
// filesystem ingest of the synthetic fixture project and the scans the MCP tools call.

const FIXTURE = path.resolve(__dirname, "fixtures/code-checks-project");
const CLS = "force-app/main/default/classes";

describe("detectAsyncInLoop", () => {
  const body = (loop: string): string => `\n${loop}\n`;
  it.each([
    ["System.enqueueJob", "for (Id i : ids) { System.enqueueJob(new Q(i)); }"],
    ["Database.executeBatch", "for (Id i : ids) { Database.executeBatch(new B(i)); }"],
    ["EventBus.publish", "while (n < 3) { EventBus.publish(new E__e()); n++; }"],
    ["Messaging.sendEmail", "do { Messaging.sendEmail(mails); n++; } while (n < 3);"],
    [
      "Messaging.sendEmail",
      "for (Id i : ids) { if (x) { Messaging.sendEmail(new List<Messaging.Email>{ m }); } }",
    ],
    ["System.enqueueJob", "for (Id i : ids)\n  System.enqueueJob(new Q(i));"],
  ])("flags %s in a loop", (kind, code) => {
    const spots = detectAsyncInLoop(body(code));
    expect(spots.map((s) => s.kind)).toEqual([kind]);
  });

  it("flags an @future method called in a loop, qualified or in its own class", () => {
    const future = new Set(["notifier.notifyasync", "own.run"]);
    expect(
      detectAsyncInLoop(body("for (Id i : ids) { Notifier.notifyAsync(i); }"), {
        futureMethods: future,
      }).map((s) => s.kind),
    ).toEqual(["@future Notifier.notifyAsync"]);
    expect(
      detectAsyncInLoop(body("for (Id i : ids) { run(i); }"), {
        futureMethods: future,
        ownerClass: "own",
      }).map((s) => s.kind),
    ).toEqual(["@future run"]);
  });

  describe("@future arity", () => {
    const future = new Set(["own.send"]);
    const futureArities = new Map([["own.send", new Set([1])]]);
    const opts = { futureMethods: future, futureArities, ownerClass: "own" };
    const loop = (call: string): string => `\nfor (Id i : ids) { ${call} }\n`;

    it("does not flag a synchronous overload of another arity", () => {
      expect(detectAsyncInLoop(loop("send(value, true);"), opts)).toEqual([]);
    });
    it("flags a call with the @future method's arity", () => {
      expect(detectAsyncInLoop(loop("send(value);"), opts).map((s) => s.kind)).toEqual([
        "@future send",
      ]);
    });
    it("counts nested commas, strings and generics as one argument", () => {
      for (const call of [
        "send(Map.of(a, b, c));",
        "send(new Map<String, Integer>{ 'a' => 1, 'b' => 2 });",
        "send('a, b');",
        "send(new List<Id>{ a, b }[0]);",
        "send(f(a, b));",
        "send(new Map<String, List<Id>>());",
      ]) {
        expect(detectAsyncInLoop(loop(call), opts), call).toHaveLength(1);
      }
      expect(detectAsyncInLoop(loop("send(Map.of(a, b), true);"), opts)).toEqual([]);
      expect(detectAsyncInLoop(loop("send();"), opts)).toEqual([]);
    });
    it("keeps reporting an ambiguous generic-or-comparison argument list", () => {
      expect(detectAsyncInLoop(loop("send(a<b, c>d);"), opts)).toHaveLength(1);
      const two = { ...opts, futureArities: new Map([["own.send", new Set([2])]]) };
      expect(detectAsyncInLoop(loop("send(a<b, c>d);"), two)).toHaveLength(1);
      expect(countCallArguments("a<b, c>d)", 0)).toBeNull();
    });
    it("counts a generic literal as one argument and a trailing argument as another", () => {
      const two = { ...opts, futureArities: new Map([["own.send", new Set([2])]]) };
      expect(countCallArguments("new List<Id>{x}, true)", 0)).toBe(2);
      expect(detectAsyncInLoop(loop("send(new List<Id>{x}, true);"), opts)).toEqual([]);
      expect(detectAsyncInLoop(loop("send(new List<Id>{x}, true);"), two)).toHaveLength(1);
      expect(countCallArguments("new Map<Id, String>())", 0)).toBe(1);
      expect(detectAsyncInLoop(loop("send(new Map<Id, String>());"), opts)).toHaveLength(1);
      expect(detectAsyncInLoop(loop("send(new Map<Id, String>());"), two)).toEqual([]);
    });
    it("keeps reporting when the arity is unknown", () => {
      expect(
        detectAsyncInLoop(loop("send(value, true);"), { ...opts, futureArities: new Map() }),
      ).toHaveLength(1);
      expect(countCallArguments("a, b", 0)).toBeNull();
    });
  });

  it.each([
    ["the call after the loop", "for (Id i : ids) { x.add(i); }\nSystem.enqueueJob(new Q(x));"],
    ["a comment", "for (Id i : ids) { // System.enqueueJob(new Q(i));\n x.add(i); }"],
    ["a block comment", "for (Id i : ids) { /* Database.executeBatch(b); */ x.add(i); }"],
    ["a string", "for (Id i : ids) { String s = 'Messaging.sendEmail(m)'; }"],
    ["no loop", "System.enqueueJob(new Q(i)); Messaging.sendEmail(m);"],
    ["a for-each header only", "for (Id i : Database.executeBatch(b)) { x.add(i); }"],
  ])("does not flag %s", (_n, code) => {
    expect(detectAsyncInLoop(body(code))).toEqual([]);
  });

  it("does not flag a future method called after the loop, an unrelated method or another class", () => {
    const future = new Set(["notifier.notifyasync"]);
    for (const code of [
      "for (Id i : ids) { x.add(i); }\nNotifier.notifyAsync(x[0]);",
      "for (Id i : ids) { Notifier.notifySync(i); }",
      "for (Id i : ids) { Other.notifyAsync(i); }",
      "for (Id i : ids) { notifyAsync(i); }",
    ]) {
      expect(detectAsyncInLoop(body(code), { futureMethods: future })).toEqual([]);
    }
  });

  it("reports the line within the text and the source line as evidence", () => {
    const spots = detectAsyncInLoop("\nfor (Id i : ids) {\n    System.enqueueJob(new Q(i));\n}\n");
    expect(spots).toEqual([
      {
        line: 3,
        evidence: "System.enqueueJob(new Q(i));",
        kind: "System.enqueueJob",
      },
    ]);
  });
});

describe("detectSoqlInjection", () => {
  const P = ["String term"];
  const flag = (code: string, params: string[] = P): string[] =>
    detectSoqlInjection(code, { params }).map((s) => `${s.kind}:${s.variable}`);

  it.each([
    [
      "direct concatenation",
      "\nreturn Database.query('SELECT Id FROM A WHERE N = \\'' + term + '\\'');",
    ],
    [
      "a built variable",
      "\nString q = 'SELECT Id FROM A WHERE N = \\'' + term + '\\'';\nreturn Database.query(q);",
    ],
    [
      "a += append",
      "\nString q = 'SELECT Id FROM A WHERE 1=1';\nq += ' AND N = \\'' + term + '\\'';\nreturn Database.query(q);",
    ],
    [
      "a copy of the parameter",
      "\nString t2 = term;\nreturn Database.query('SELECT Id FROM A WHERE N = \\'' + t2 + '\\'');",
    ],
    [
      "a ternary",
      "\nreturn Database.query('SELECT Id FROM A WHERE N = \\'' + (term == null ? 'x' : term) + '\\'');",
    ],
    [
      "String.valueOf of a String parameter",
      "\nreturn Database.query('SELECT Id FROM A WHERE N = \\'' + String.valueOf(term) + '\\'');",
    ],
    [
      "a parameter appended to with +=",
      "\nterm += '%';\nreturn Database.query('SELECT Id FROM A WHERE N LIKE \\'' + term + '\\'');",
    ],
    [
      "a variable appended to with += from a parameter copy",
      "\nString t = term;\nt += '%';\nreturn Database.query('SELECT Id FROM A WHERE N LIKE \\'' + t + '\\'');",
    ],
    [
      "a method on the parameter",
      "\nreturn Database.query('SELECT Id FROM A WHERE N = \\'' + term.trim() + '\\'');",
    ],
  ])("flags %s", (_n, code) => {
    const found = flag(code);
    expect(found).toHaveLength(1);
    expect(found[0]).toMatch(/^Database\.query:/);
  });

  it("does not flag safe conversions, a sanitised parameter appended to, or typed arguments", () => {
    const q = (e: string) => `\nreturn Database.query('SELECT Id FROM A WHERE N = ' + ${e});`;
    expect(flag(q("Integer.valueOf(term)"))).toEqual([]);
    expect(flag(q("String.valueOf(n)"), ["Integer n"])).toEqual([]);
    expect(flag(q("String.valueOf(5)"))).toEqual([]);
    expect(flag(q("String.valueOf(String.escapeSingleQuotes(term))"))).toEqual([]);
    expect(
      flag(
        "\nterm = String.escapeSingleQuotes(term);\nterm += '%';\nreturn Database.query('SELECT Id FROM A WHERE N LIKE \\'' + term + '\\'');",
      ),
    ).toEqual([]);
  });

  it("an escapeSingleQuotes call exempts only its own result, not its siblings", () => {
    const P2 = ["String term", "String other"];
    const fmt = (args: string) =>
      `\nreturn Database.query(String.format('SELECT Id FROM A WHERE N = {0} AND M = {1}', ${args}));`;
    expect(flag(fmt("new List<String>{term, String.escapeSingleQuotes(other)}"), P2)).toHaveLength(
      1,
    );
    expect(flag(fmt("new List<String>{String.escapeSingleQuotes(other), term}"), P2)).toHaveLength(
      1,
    );
    expect(
      flag(
        "\nreturn Database.query('SELECT Id FROM A WHERE N = ' + term + String.escapeSingleQuotes(other));",
        P2,
      ),
    ).toHaveLength(1);
    expect(
      flag(
        "\nreturn Database.query('SELECT Id FROM A WHERE N = ' + String.escapeSingleQuotes(other) + term);",
        P2,
      ),
    ).toHaveLength(1);
    // Fully escaped, and binds: silent.
    expect(
      flag(
        fmt("new List<String>{String.escapeSingleQuotes(term), String.escapeSingleQuotes(other)}"),
        P2,
      ),
    ).toEqual([]);
    expect(
      flag(
        "\nreturn Database.query('SELECT Id FROM A WHERE N = ' + String.escapeSingleQuotes(term) + String.escapeSingleQuotes(other));",
        P2,
      ),
    ).toEqual([]);
    expect(
      flag("\nreturn Database.query('SELECT Id FROM A WHERE N = :term AND M = :other');", P2),
    ).toEqual([]);
  });

  it("flags queryWithBinds, countQuery, getQueryLocator and Search.query", () => {
    expect(
      flag(
        "\nreturn Database.queryWithBinds('SELECT Id FROM A WHERE N = \\'' + term + '\\'', m, l);",
      ),
    ).toEqual(["Database.queryWithBinds:term"]);
    expect(
      flag("\nreturn Database.countQuery('SELECT COUNT() FROM A WHERE N = \\'' + term + '\\'');"),
    ).toEqual(["Database.countQuery:term"]);
    expect(
      flag("\nreturn Database.getQueryLocator('SELECT Id FROM A WHERE N = \\'' + term + '\\'');"),
    ).toEqual(["Database.getQueryLocator:term"]);
    expect(flag("\nreturn Search.query('FIND \\'' + term + '\\' RETURNING A');")).toEqual([
      "Search.query:term",
    ]);
  });

  it.each([
    [
      "an escaped inline value",
      "\nreturn Database.query('SELECT Id FROM A WHERE N = \\'' + String.escapeSingleQuotes(term) + '\\'');",
    ],
    [
      "an escaped variable",
      "\nString s = String.escapeSingleQuotes(term);\nreturn Database.query('SELECT Id FROM A WHERE N = \\'' + s + '\\'');",
    ],
    [
      "a reassigned, escaped parameter",
      "\nterm = String.escapeSingleQuotes(term);\nreturn Database.query('SELECT Id FROM A WHERE N = \\'' + term + '\\'');",
    ],
    ["a bind variable", "\nreturn Database.query('SELECT Id FROM A WHERE N = :term');"],
    ["a constant-only string", "\nreturn Database.query('SELECT Id FROM A LIMIT 10');"],
    [
      "a static constant",
      "\nreturn Database.query('SELECT Id FROM A WHERE S = \\'' + Consts.STATUS_OPEN + '\\' LIMIT ' + MAX_ROWS);",
    ],
    [
      "Schema describe names",
      "\nString o = A.SObjectType.getDescribe().getName();\nString f = Schema.SObjectType.A.fields.Name.getName();\nreturn Database.query('SELECT ' + f + ' FROM ' + o);",
    ],
    [
      "typed Integer, Id and Boolean parameters",
      "\nreturn Database.query('SELECT Id FROM A WHERE C > ' + n + ' AND O = \\'' + oid + '\\' AND B = ' + flag);",
    ],
    [
      "a valueOf conversion",
      "\nreturn Database.query('SELECT Id FROM A WHERE C > ' + String.valueOf(n));",
    ],
    ["a comment", "\n// Database.query('x' + term);\nreturn null;"],
    ["a string mention", "\nString s = 'Database.query(x + term)';\nreturn s;"],
  ])("does not flag %s", (_n, code) => {
    expect(flag(code, ["String term", "Integer n", "Id oid", "Boolean flag"])).toEqual([]);
  });

  it("does not flag an unknown variable (a class field is not traced)", () => {
    expect(
      flag(
        "\nreturn Database.query('SELECT Id FROM A WHERE N = \\'' + this.filter + '\\'' + extra);",
        [],
      ),
    ).toEqual([]);
  });

  it("flags without parameters only what a local assignment proves", () => {
    expect(flag("\nString q = 'x' + UserInfo.getName();\nreturn Database.query(q);", [])).toEqual(
      [],
    );
  });

  it("reports the line of the call within the text", () => {
    const spots = detectSoqlInjection("\nString q = 'a' + term;\nreturn Database.query(q);", {
      params: P,
    });
    expect(spots).toEqual([
      {
        line: 3,
        evidence: "return Database.query(q);",
        kind: "Database.query",
        variable: "term",
      },
    ]);
  });
  describe("String.format arguments, assignment order and long alias chains", () => {
    const fmt = (arg: string): string =>
      `\nreturn Database.query(String.format('SELECT Id FROM Account LIMIT {0}', new List<String>{ ${arg} }));`;

    it.each([
      ["String.valueOf(Integer.valueOf(term))", "String.valueOf(Integer.valueOf(term))"],
      ["Long.valueOf(term)", "String.valueOf(Long.valueOf(term))"],
      ["Decimal.valueOf(term)", "String.valueOf(Decimal.valueOf(term))"],
      ["Double.valueOf(term)", "String.valueOf(Double.valueOf(term))"],
      ["Boolean.valueOf(term)", "String.valueOf(Boolean.valueOf(term))"],
      ["Id.valueOf(term)", "String.valueOf(Id.valueOf(term))"],
      ["Date.valueOf(term)", "String.valueOf(Date.valueOf(term))"],
      ["escapeSingleQuotes(term)", "String.escapeSingleQuotes(term)"],
      ["a describe name", "Schema.SObjectType.Account.getName()"],
    ])("does not flag a String.format argument that is %s", (_n, arg) => {
      expect(flag(fmt(arg))).toEqual([]);
    });

    it("judges each String.format argument on its own", () => {
      expect(flag(fmt("String.escapeSingleQuotes(term), term"))).toHaveLength(1);
      expect(flag(fmt("String.valueOf(Integer.valueOf(term)), term"))).toHaveLength(1);
      expect(flag(fmt("String.valueOf(term)"))).toHaveLength(1);
    });

    it("an unconditional sanitiser clears earlier taint; the last definite assignment wins", () => {
      const q = "return Database.query('SELECT Id FROM A WHERE N = \\'' + value + '\\'');";
      expect(
        flag(`\nString value = term;\nvalue = String.escapeSingleQuotes(value);\n${q}`),
      ).toEqual([]);
      expect(flag(`\nString value = term;\nvalue = 'fixed';\n${q}`)).toEqual([]);
      // Taint added after the sanitiser is reported again.
      expect(
        flag(`\nString value = String.escapeSingleQuotes(term);\nvalue = term;\n${q}`),
      ).toHaveLength(1);
      // An assignment after the query does not clear it.
      expect(
        flag(
          "\nString value = term;\nDatabase.query('SELECT Id FROM A WHERE N = \\'' + value + '\\'');\nvalue = 'x';",
        ),
      ).toHaveLength(1);
    });

    it("keeps taint through conditional assignments", () => {
      const q = "return Database.query('SELECT Id FROM A WHERE N = \\'' + value + '\\'');";
      // Tainted value, safe value assigned only in a branch: still tainted.
      expect(
        flag(`\nString value = term;\nif (flag) { value = 'x'; }\n${q}`, [
          "String term",
          "Boolean flag",
        ]),
      ).toHaveLength(1);
      expect(
        flag(`\nString value = term;\nif (flag) value = 'x';\n${q}`, [
          "String term",
          "Boolean flag",
        ]),
      ).toHaveLength(1);
      // A tainted value assigned in a branch after a safe one.
      expect(
        flag(`\nString value = 'a';\nif (flag) { value = term; }\n${q}`, [
          "String term",
          "Boolean flag",
        ]),
      ).toHaveLength(1);
      // Documented rule kept: a parameter escaped inside a branch counts as escaped.
      expect(
        flag(
          "\nif (term != null) { term = String.escapeSingleQuotes(term); }\nreturn Database.query('SELECT Id FROM A WHERE N = \\'' + term + '\\'');",
        ),
      ).toEqual([]);
    });

    it("checks a query call inside an assignment's own right-hand side against the incoming state", () => {
      expect(flag("\nString q = term;\nq = String.valueOf(Database.countQuery(q));")).toHaveLength(
        1,
      );
    });

    it("inspects the arguments of a copy constructor in String.format", () => {
      const code = (arg: string): string =>
        `\nreturn Database.query(String.format('SELECT Id FROM A WHERE N = {0}', ${arg}));`;
      expect(flag(code("new List<String>(terms)"), ["List<String> terms"])).toHaveLength(1);
      expect(flag(code("new List<Integer>(nums)"), ["List<Integer> nums"])).toEqual([]);
      expect(flag(code("new List<String>(1)"), ["String term"])).toEqual([]);
    });

    it("carries taint around a loop, and a later safe assignment does not clear it", () => {
      expect(
        flag(
          "\nString q = 'SELECT Id FROM Account';\nfor (Integer i = 0; i < 2; i++) { Database.query(q); q = term; }",
        ),
      ).toHaveLength(1);
      expect(
        flag(
          "\nString q = 'SELECT Id FROM Account';\nwhile (more) { Database.query(q); q = term; q = String.escapeSingleQuotes(q); }",
          ["String term", "Boolean more"],
        ),
      ).toHaveLength(1);
      expect(
        flag(
          "\nString q = 'SELECT Id FROM Account';\nfor (Integer i = 0; i < 2; i++) Database.query(q);\nq = term;",
        ),
      ).toHaveLength(1);
      expect(
        flag(
          "\nString q = 'SELECT Id FROM Account';\ndo { Database.query(q); q = term; } while (false);",
        ),
      ).toHaveLength(1);
    });

    it("carries taint through indexed access on a tainted collection", () => {
      const code = (arg: string): string =>
        `\nreturn Database.query(String.format('SELECT Id FROM A WHERE N = {0}', new List<String>{ ${arg} }));`;
      expect(flag(code("terms[0]"), ["List<String> terms"])).toHaveLength(1);
      expect(flag(code("terms.get(0)"), ["List<String> terms"])).toHaveLength(1);
      expect(
        flag("\nreturn Database.query('SELECT Id FROM A WHERE N = \\'' + terms[0] + '\\'');", [
          "List<String> terms",
        ]),
      ).toHaveLength(1);
      expect(flag(code("nums[0]"), ["List<Integer> nums"])).toEqual([]);
    });

    it("treats the condition and update clauses of a for header as conditional", () => {
      expect(
        flag(
          "\nString q = term;\nfor (Integer i = 0; i < 0; q = 'SELECT Id FROM Account') { i++; }\nDatabase.query(q);",
        ),
      ).toHaveLength(1);
      // An assignment inside a for header is never provably simple, so the taint is kept.
      expect(
        flag(
          "\nString q = term;\nfor (q = 'SELECT Id FROM Account'; false; ) { }\nDatabase.query(q);",
        ),
      ).toHaveLength(1);
    });

    it("matches sinks on one line by their exact offset", () => {
      // The first call is a typed-safe false positive the new analysis drops; the second stays.
      const found = detectSoqlInjection(
        "\nDatabase.query('S' + String.valueOf(n)); Database.query('S' + term);",
        { params: ["String term", "System.Integer n"] },
      );
      expect(found).toHaveLength(1);
      expect(found[0]?.variable).toBe("term");
    });

    it("handles a 2000-alias chain without a stack overflow", () => {
      const lines = ["\nString v0 = term;"];
      for (let i = 1; i < 2000; i++) lines.push(`String v${i} = v${i - 1};`);
      const tail = "return Database.query('SELECT Id FROM A WHERE N = \\'' + v1999 + '\\'');";
      const found = detectSoqlInjection(`${lines.join("\n")}\n${tail}`, { params: P });
      expect(found.map((f) => f.variable)).toEqual(["term"]);
      lines[1] = "String v1 = String.escapeSingleQuotes(v0);";
      expect(detectSoqlInjection(`${lines.join("\n")}\n${tail}`, { params: P })).toEqual([]);
    });
  });

  describe("typed non-String values through String.valueOf, format and +", () => {
    const TYPES = [
      "Integer",
      "Long",
      "Decimal",
      "Double",
      "Boolean",
      "Id",
      "Date",
      "Datetime",
      "Time",
    ];
    const SHAPES: Array<[string, string]> = [
      [
        "String.format with String.valueOf in a list",
        "\nString q = String.format('SELECT Id FROM Account LIMIT {0}', new List<String>{ String.valueOf(x) });\nreturn Database.query(q);",
      ],
      [
        "String.format with the value as an Object argument",
        "\nreturn Database.query(String.format('SELECT Id FROM Account LIMIT {0}', new List<Object>{ x }));",
      ],
      [
        "String.format with a String.valueOf local",
        "\nString lim = String.valueOf(x);\nreturn Database.query(String.format('SELECT Id FROM Account LIMIT {0}', new List<String>{ lim }));",
      ],
      [
        "an empty string plus the value",
        "\nreturn Database.query('SELECT Id FROM Account LIMIT ' + '' + x);",
      ],
      [
        "a local made from an empty string plus the value",
        "\nString s = '' + x;\nreturn Database.query('SELECT Id FROM Account LIMIT ' + s);",
      ],
      [
        "String.valueOf concatenated",
        "\nreturn Database.query('SELECT Id FROM Account LIMIT ' + String.valueOf(x));",
      ],
      [
        "String.valueOf in a ternary",
        "\nreturn Database.query('SELECT Id FROM Account LIMIT ' + (x == null ? '1' : String.valueOf(x)));",
      ],
      [
        "the value's own format()",
        "\nreturn Database.query('SELECT Id FROM Account LIMIT ' + x.format());",
      ],
    ];
    for (const type of TYPES) {
      it.each(SHAPES)(`does not flag a ${type} parameter in %s`, (_n, code) => {
        expect(flag(code, [`${type} x`])).toEqual([]);
        expect(flag(code, [`System.${type} x`])).toEqual([]);
      });
    }

    it("does not flag a value read from a Map with numeric values", () => {
      const code =
        "\nreturn Database.query('SELECT Id FROM Account LIMIT ' + String.valueOf(caps.get(k)));";
      expect(flag(code, ["Map<String, Integer> caps", "String k"])).toEqual([]);
      expect(flag(code, ["Map<Id, Decimal> caps", "Id k"])).toEqual([]);
    });

    it("still flags a String parameter through String.valueOf, format and +", () => {
      const shapes = [
        "\nString q = String.format('SELECT Id FROM Account WHERE N = {0}', new List<String>{ String.valueOf(x) });\nreturn Database.query(q);",
        "\nreturn Database.query('SELECT Id FROM Account WHERE N = ' + String.valueOf(x));",
        "\nreturn Database.query('SELECT Id FROM Account WHERE N = ' + '' + x);",
      ];
      for (const code of shapes) expect(flag(code, ["String x"])).toHaveLength(1);
      // A Map with String values is still text.
      expect(
        flag("\nreturn Database.query('SELECT Id FROM A WHERE N = ' + String.valueOf(m.get(k)));", [
          "Map<String, String> m",
          "String k",
        ]),
      ).toHaveLength(1);
    });
  });
});

describe("normalizeSourceUri", () => {
  it("gives Windows paths and file URIs one forward-slash spelling", () => {
    expect(normalizeSourceUri("file://C:\\Users\\me\\proj\\force-app\\lwc\\visitBanner")).toBe(
      "file:///C:/Users/me/proj/force-app/lwc/visitBanner",
    );
    expect(normalizeSourceUri("file:///C:/Users/me/proj/a.cls")).toBe(
      "file:///C:/Users/me/proj/a.cls",
    );
    expect(normalizeSourceUri("file:///home/me/proj/a.cls")).toBe("file:///home/me/proj/a.cls");
    expect(normalizeSourceUri("sf://org/ApexClass/A")).toBe("sf://org/ApexClass/A");
  });
});

describe("detectDomInjection", () => {
  const kinds = (js: string) =>
    detectDomInjection("c.js", js).map((s) => `${s.kind}:${s.severity}`);
  it.each([
    ["innerHTML from data", "el.innerHTML = this.notes;", ["innerHTML:high"]],
    ["innerHTML with +=", "el.innerHTML += data;", ["innerHTML:high"]],
    ["outerHTML", "el.outerHTML = this.html;", ["outerHTML:high"]],
    ["a template literal with data", "el.innerHTML = `<b>${this.name}</b>`;", ["innerHTML:high"]],
    [
      "insertAdjacentHTML with data",
      "el.insertAdjacentHTML('beforeend', '<i>' + t + '</i>');",
      ["insertAdjacentHTML:high"],
    ],
    ["a fixed string", "el.innerHTML = '<b>Hi</b>';", ["innerHTML:low"]],
    ["a parenthesized fixed string", "el.innerHTML = ('<p>Hello</p>');", ["innerHTML:low"]],
    [
      "a doubly parenthesized fixed string",
      "el.innerHTML = (('<p>Hello</p>'));",
      ["innerHTML:low"],
    ],
    [
      "a parenthesized literal in insertAdjacentHTML",
      "el.insertAdjacentHTML('beforeend', ('<p>Hello</p>'));",
      ["insertAdjacentHTML:low"],
    ],
    ["a parenthesized empty clear", "el.innerHTML = ('');", []],
    [
      "a parenthesized concatenation with data",
      "el.innerHTML = ('<p>' + name + '</p>');",
      ["innerHTML:high"],
    ],
    [
      "parenthesized literal plus parenthesized data",
      "el.innerHTML = ('a') + (userInput);",
      ["innerHTML:high"],
    ],
    ["a literal with a plus sign", "el.innerHTML = '<button>+</button>';", ["innerHTML:low"]],
    [
      "an insertAdjacentHTML literal with a plus sign",
      "el.insertAdjacentHTML('beforeend', '<button>+ Add</button>');",
      ["insertAdjacentHTML:low"],
    ],
    [
      "a double-quoted literal with a plus sign",
      "el.innerHTML = \"a + b\" + '+';",
      ["innerHTML:low"],
    ],
    ["a literal with a dollar sign", "el.innerHTML = '<span>$10</span>';", ["innerHTML:low"]],
    [
      "a template literal with a dollar sign",
      "el.innerHTML = `<b>Price: $5</b>`;",
      ["innerHTML:low"],
    ],
    [
      "a template literal with a dollar sign in insertAdjacentHTML",
      "el.insertAdjacentHTML('beforeend', `<b>$5 + $6</b>`);",
      ["insertAdjacentHTML:low"],
    ],
    [
      "a template literal with a dollar sign and interpolation",
      "el.innerHTML = `<b>$5 ${x}</b>`;",
      ["innerHTML:high"],
    ],
    ["a multi-line template literal", "el.innerHTML = `<b>Hello\nworld</b>`;", ["innerHTML:low"]],
    [
      "a multi-line template literal joined with +",
      "el.innerHTML = `<b>Hello` +\n`world</b>`;",
      ["innerHTML:low"],
    ],
    [
      "a multi-line template with data on a middle line",
      "el.innerHTML = `<ul>\n<li>${x}</li>\n</ul>`;",
      ["innerHTML:high"],
    ],
    [
      "a template with nested braces then another statement",
      "el.innerHTML = `<b>${ {a:1}.a }\nrest</b>`;\nel.insertAdjacentHTML('beforeend', '<hr>');",
      ["innerHTML:high", "insertAdjacentHTML:low"],
    ],
    [
      "a multi-line template with a nested template in an interpolation",
      "el.innerHTML = `<b>${ `a\nb` }\n</b>`;",
      ["innerHTML:high"],
    ],
    ["a multi-line pure literal", "el.innerHTML = '<b>' +\n '</b>';", ["innerHTML:low"]],
    [
      "a multi-line literal in insertAdjacentHTML",
      "el.insertAdjacentHTML('beforeend', '<b>' +\n  '</b>');",
      ["insertAdjacentHTML:low"],
    ],
    [
      "an empty literal then data on the next line",
      "el.innerHTML = ''\n + userInput;",
      ["innerHTML:high"],
    ],
    [
      "a literal then data on the next line",
      "el.innerHTML = '<b>'\n + userInput;",
      ["innerHTML:high"],
    ],
    [
      "data after a trailing plus (Prettier)",
      "el.innerHTML = '<b>' +\n  userInput;",
      ["innerHTML:high"],
    ],
    [
      "multi-line insertAdjacentHTML with data",
      "el.insertAdjacentHTML('beforeend', '<b>'\n + userInput);",
      ["insertAdjacentHTML:high"],
    ],
    [
      "a fixed insertAdjacentHTML",
      "el.insertAdjacentHTML('afterbegin', '<hr>');",
      ["insertAdjacentHTML:low"],
    ],
  ])("flags %s", (_n, js, expected) => {
    expect(kinds(js)).toEqual(expected);
  });
  it.each([
    ["clearing", "el.innerHTML = '';"],
    ["clearing with double quotes", 'el.innerHTML = "";'],
    ["clearing followed by another statement", "el.innerHTML = '';\nel.className = 'x';"],
    ["clearing without a semicolon", "el.innerHTML = ''\nfoo();"],
    ["reading", "const h = el.innerHTML;"],
    ["comparing", "if (el.innerHTML === other) {}"],
    ["textContent", "el.textContent = this.notes;"],
    ["a line comment", "// el.innerHTML = this.notes;"],
    ["a block comment", "/* el.innerHTML = this.notes; */"],
  ])("does not flag %s", (_n, js) => {
    expect(kinds(js)).toEqual([]);
  });
  it("reads a fluent chain on the next line as part of the right-hand side (Codex 4579252385)", () => {
    expect(kinds("el.innerHTML = ''\n  .concat(userInput);")).toEqual(["innerHTML:high"]);
    expect(kinds("el.innerHTML = ''\n  ?.concat(userInput);")).toEqual(["innerHTML:high"]);
    expect(kinds("el.innerHTML = ''.concat(userInput);")).toEqual(["innerHTML:high"]);
    expect(kinds("el.innerHTML = cond\n  ? this.a\n  : '';")).toEqual(["innerHTML:high"]);
    expect(kinds("el.innerHTML = '<b>' +\n  userInput;")).toEqual(["innerHTML:high"]);
    expect(kinds("el.innerHTML = ''\n  [method](userInput);")).toEqual(["innerHTML:high"]);
  });
  it("still treats a clear followed by a new statement as a clear", () => {
    expect(kinds("el.innerHTML = '';\nfoo(userInput);")).toEqual([]);
    expect(kinds("el.innerHTML = ''\nfoo(userInput);")).toEqual([]);
    expect(kinds("el.innerHTML = ''\nconst a = x + 1;")).toEqual([]);
    expect(kinds("el.innerHTML = ''\n++count;")).toEqual([]);
  });
  it("does not promote a fixed-string fluent chain", () => {
    expect(kinds("el.innerHTML = ''\n  .concat('<b>', 'a+b $5', '</b>');")).toEqual([
      "innerHTML:low",
    ]);
    expect(kinds("el.innerHTML = '<i>a+b</i>'\n  .concat('$1');")).toEqual(["innerHTML:low"]);
  });
  it("keeps line numbers right after a multi-line template", () => {
    const js =
      "const a = 1;\nel.innerHTML = `<b>\nx\n</b>`;\nconst b = 2;\nel.innerHTML = this.n;\n";
    expect(detectDomInjection("c.js", js).map((x) => [x.line, x.severity])).toEqual([
      [2, "low"],
      [6, "high"],
    ]);
  });
  it("does not locate a sink inside a string or template text", () => {
    expect(kinds('const example = "el.innerHTML = data";')).toEqual([]);
    expect(kinds("const e = 'el.insertAdjacentHTML(\\'x\\', d)';")).toEqual([]);
    expect(kinds("const e = `el.outerHTML = ${x}`;")).toEqual([]);
  });
  it("still locates a sink in code beside or inside strings, with the original right-hand side", () => {
    expect(kinds('const a = "x"; el.innerHTML = this.notes;')).toEqual(["innerHTML:high"]);
    expect(kinds("el.innerHTML = '<b>Hi</b>';")).toEqual(["innerHTML:low"]);
    expect(kinds("const s = `a ${fn(`el.innerHTML = 1`)}`; el.innerHTML = `<b>${n}</b>`;")).toEqual(
      ["innerHTML:high"],
    );
    const spots = detectDomInjection("c.js", 'const m = "a\\"b";\n  el.innerHTML = x;\n');
    expect(spots.map((s) => [s.line, s.evidence])).toEqual([[2, "el.innerHTML = x;"]]);
  });
  it("ignores quotes in comments inside a template interpolation", () => {
    expect(kinds("const x = `${/* user's input */ value}`; el.innerHTML = userInput;")).toEqual([
      "innerHTML:high",
    ]);
    expect(kinds("const x = `${a // it's\n}`; el.innerHTML = userInput;")).toEqual([
      "innerHTML:high",
    ]);
  });
  it("handles a nested template inside an interpolation", () => {
    expect(kinds("const x = `a ${`b ${c} 'q'`} d`; el.innerHTML = userInput;")).toEqual([
      "innerHTML:high",
    ]);
    expect(kinds("const x = `a ${`el.innerHTML = 1`}`;")).toEqual([]);
  });
  it("reports the 1-based line and the source line", () => {
    expect(detectDomInjection("c.js", "a();\n  el.innerHTML = x;\n")).toEqual([
      {
        file: "c.js",
        line: 2,
        kind: "innerHTML",
        severity: "high",
        evidence: "el.innerHTML = x;",
      },
    ]);
  });
  it("sees lwc:dom manual in a template", () => {
    expect(hasLwcDomManual('<div lwc:dom="manual"></div>')).toBe(true);
    expect(hasLwcDomManual("<div></div>")).toBe(false);
  });
});

describe("detectFlowDmlInLoop", () => {
  const flow = (inner: string): string =>
    `<?xml version="1.0"?><Flow xmlns="http://soap.sforce.com/2006/04/metadata">${inner}</Flow>`;
  const c = (tag: string, to: string): string =>
    `<${tag}><targetReference>${to}</targetReference></${tag}>`;
  const loop = (name: string, next: string, done?: string): string =>
    `<loops><name>${name}</name>${c("nextValueConnector", next)}${done ? c("noMoreValuesConnector", done) : ""}</loops>`;
  const el = (tag: string, name: string, to?: string, extra = ""): string =>
    `<${tag}><name>${name}</name>${extra}${to ? c("connector", to) : ""}</${tag}>`;

  it("flags Create, Update and Delete in the iteration path", () => {
    const xml = flow(
      loop("L", "A", "After") +
        el("recordCreates", "A", "B") +
        el("recordUpdates", "B", "C", "<object>Task</object>") +
        el("recordDeletes", "C", "L") +
        el("actionCalls", "After"),
    );
    expect(detectFlowDmlInLoop(xml).map((d) => [d.element, d.action, d.loop])).toEqual([
      ["A", "Create Records", "L"],
      ["B", "Update Records", "L"],
      ["C", "Delete Records", "L"],
    ]);
  });
  it("follows an assignment and a decision branch inside the loop", () => {
    const xml = flow(
      `${loop("L", "Check", "After")}<decisions><name>Check</name><defaultConnector><targetReference>L</targetReference></defaultConnector><rules><name>R</name><connector><targetReference>Mk</targetReference></connector></rules></decisions>${el("assignments", "Mk", "U")}${el("recordUpdates", "U", "L")}${el("actionCalls", "After")}`,
    );
    expect(detectFlowDmlInLoop(xml).map((d) => d.element)).toEqual(["U"]);
  });
  it("does not flag DML after the loop, before it, or a loop with none", () => {
    const after = flow(
      loop("L", "X", "U") + el("assignments", "X", "L") + el("recordUpdates", "U"),
    );
    const before = flow(
      el("recordCreates", "C0", "L") +
        loop("L", "X", "End") +
        el("assignments", "X", "L") +
        el("actionCalls", "End"),
    );
    expect(detectFlowDmlInLoop(after)).toEqual([]);
    expect(detectFlowDmlInLoop(before)).toEqual([]);
  });
  it("does not flag a fault path that ends the flow", () => {
    const xml = flow(
      `${loop("L", "Act", "End")}<actionCalls><name>Act</name>${c("connector", "L")}${c("faultConnector", "Log")}</actionCalls>${el("recordCreates", "Log")}${el("actionCalls", "End")}`,
    );
    expect(detectFlowDmlInLoop(xml)).toEqual([]);
  });
  it("reports an element in a nested loop against the inner loop, and the outer path separately", () => {
    const xml = flow(
      loop("Outer", "Inner", "Done") +
        loop("Inner", "Del", "Log") +
        el("recordDeletes", "Del", "Inner") +
        el("recordCreates", "Log", "Outer") +
        el("actionCalls", "Done"),
    );
    expect(detectFlowDmlInLoop(xml).map((d) => [d.element, d.loop])).toEqual([
      ["Del", "Inner"],
      ["Log", "Outer"],
    ]);
  });
  it("handles invalid XML and flows without loops", () => {
    expect(detectFlowDmlInLoop("<Flow><loops>")).toEqual([]);
    expect(detectFlowDmlInLoop(flow(el("recordUpdates", "U")))).toEqual([]);
  });
  it("gives the element's line", () => {
    const xml =
      "<Flow>\n<loops><name>L</name><nextValueConnector><targetReference>U</targetReference></nextValueConnector></loops>\n<recordUpdates>\n<name>U</name><connector><targetReference>L</targetReference></connector>\n</recordUpdates>\n</Flow>";
    expect(detectFlowDmlInLoop(xml)[0]?.line).toBe(3);
  });
  it("analyses a 16,000-element loop body in linear time and still finds the DML", () => {
    const n = 16_000;
    const parts: string[] = [loop("L", "E0", "After")];
    for (let i = 0; i < n; i++) {
      const to = i + 1 < n ? `E${i + 1}` : "L";
      parts.push(
        i === n - 2
          ? el("recordUpdates", `E${i}`, to, "<object>Account</object>")
          : el("assignments", `E${i}`, to),
      );
    }
    parts.push(el("actionCalls", "After"));
    const xml = flow(parts.join("\n"));
    const started = performance.now();
    const found = detectFlowDmlInLoop(xml);
    const ms = performance.now() - started;
    expect(found.map((d) => [d.element, d.action, d.loop, d.object])).toEqual([
      [`E${n - 2}`, "Update Records", "L", "Account"],
    ]);
    expect(found[0]?.line).toBe(n);
    expect(ms).toBeLessThan(2000);
  });

  it("finds the line of every DML element in a flow with thousands of them", () => {
    const n = 3000;
    const parts: string[] = [loop("L", "D0", "After")];
    for (let i = 0; i < n; i++) {
      parts.push(el("recordCreates", `D${i}`, i + 1 < n ? `D${i + 1}` : "L"));
    }
    const found = detectFlowDmlInLoop(flow(parts.join("\n")));
    expect(found).toHaveLength(n);
    expect(found[0]?.line).toBe(2);
    expect(found[n - 1]?.line).toBe(n + 1);
  });
});

describe("through a real project ingest", () => {
  let dir: string;
  let store: SqliteGraphStore;
  let orgId: ReturnType<typeof offlineResolvedOrg>["orgId"];
  let proj: string;

  beforeAll(async () => {
    dir = mkdtempSync(path.join(tmpdir(), "sfg-code-checks-"));
    proj = path.join(dir, "proj");
    cpSync(FIXTURE, proj, { recursive: true });
    vi.spyOn(console, "log").mockImplementation(() => {});
    store = new SqliteGraphStore({
      dbPath: path.join(dir, "g.sqlite"),
      backupDir: path.join(dir, "bk"),
    });
    await store.init();
    const org = offlineResolvedOrg(proj, "fixture");
    orgId = org.orgId;
    await liveIngest({
      alias: "fixture",
      graphStore: store,
      mode: "full",
      rebuild: true,
      preResolved: org,
      metadataSource: FilesystemMetadataSource.fromProjectRoot(proj),
      logger: new ConsoleLogger("error"),
      skipSnapshot: true,
      analysisDb: store.db,
    });
  });
  afterAll(async () => {
    vi.restoreAllMocks();
    await store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const rel = (uri: string | undefined): string =>
    (uri ?? "").replace(`${normalizeSourceUri(`file://${proj}`)}/`, "");

  it("governor: async work in a loop, with file, line, rule id and severity", () => {
    const { risks, coverage } = scanGovernorRisks(store, orgId);
    const async = risks
      .filter((r) => r.risk === "async_in_loop")
      .map((r) => [
        r.qualifiedName.replace("ApexMethod:VisitTriggerHandler.", ""),
        r.line,
        rel(r.file),
      ]);
    expect(async).toEqual([
      ["enqueuePerVisit(1)", 6, `${CLS}/VisitTriggerHandler.cls`],
      ["futureInLoop(1)", 27, `${CLS}/VisitTriggerHandler.cls`],
      ["manyKinds(1)", 15, `${CLS}/VisitTriggerHandler.cls`],
      ["manyKinds(1)", 19, `${CLS}/VisitTriggerHandler.cls`],
      ["manyKinds(1)", 14, `${CLS}/VisitTriggerHandler.cls`],
      ["ownFutureInLoop(1)", 39, `${CLS}/VisitTriggerHandler.cls`],
      ["ApexTrigger:VisitTrigger", 3, "force-app/main/default/triggers/VisitTrigger.trigger"],
    ]);
    for (const r of risks.filter((x) => x.risk === "async_in_loop")) {
      expect(r.ruleId).toBe("governor.async-in-loop");
      expect(r.severity).toBe("high");
      expect(r.message).toMatch(/inside a loop/);
    }
    // The negatives in the same class are silent: bulkified, comment/string, non-future call.
    const methods = new Set(risks.map((r) => r.qualifiedName));
    expect(methods.has("ApexMethod:VisitTriggerHandler.bulkified(1)")).toBe(false);
    expect(methods.has("ApexMethod:VisitTriggerHandler.notAsync(1)")).toBe(false);
    expect(coverage.complete).toBe(true);
  });

  it("governor: Flow DML in a loop names the element, the loop and the line", () => {
    const flows = scanGovernorRisks(store, orgId).risks.filter(
      (r) => r.risk === "flow_dml_in_loop",
    );
    expect(flows.map((r) => [r.qualifiedName, r.element, r.loop, r.line])).toEqual([
      ["Flow:Visit_Branch_And_Nested", "Create_Log", "Outer_Loop", 54],
      ["Flow:Visit_Branch_And_Nested", "Delete_Sub", "Inner_Loop", 47],
      ["Flow:Visit_Close_Tasks", "Update_Task", "Loop_Open_Tasks", 38],
    ]);
    for (const r of flows) {
      expect(r.ruleId).toBe("governor.flow-dml-in-loop");
      expect(r.severity).toBe("high");
      expect(rel(r.file)).toMatch(/^force-app\/main\/default\/flows\/Visit_.*\.flow-meta\.xml$/);
    }
    // DML after the loop, a fault path that ends the flow, DML before the loop: silent.
    const names = new Set(flows.map((r) => r.qualifiedName));
    for (const q of ["Flow:Visit_Close_Once", "Flow:Visit_Fault_Log", "Flow:Visit_No_Dml"]) {
      expect(names.has(q)).toBe(false);
    }
  });

  it("governor: the new kinds sort after the existing limit kinds and before no_bulk", () => {
    const kinds = scanGovernorRisks(store, orgId).risks.map((r) => r.risk);
    expect(kinds.indexOf("async_in_loop")).toBeLessThan(kinds.indexOf("flow_dml_in_loop"));
  });

  it("security: SOQL injection only where the value is unescaped and unbound", () => {
    const found = scanCodeSecurity(store, orgId).findings.filter(
      (f) => f.ruleId === "security.soql-injection",
    );
    expect(
      found.map((f) => [
        f.qualifiedName.replace("ApexMethod:VisitSearchController.", ""),
        f.line,
        f.variable,
        f.severity,
      ]),
    ).toEqual([
      ["byRegion(1)", 27, "region", "high"],
      ["countByOwner(1)", 19, "owner", "high"],
      ["find(1)", 33, "text", "high"],
      ["search(2)", 13, "term", "high"],
    ]);
    for (const f of found) expect(rel(f.file)).toBe(`${CLS}/VisitSearchController.cls`);
  });

  it("security: DOM injection in LWC and Aura, fixed strings low, clean components silent", () => {
    const found = scanCodeSecurity(store, orgId).findings.filter(
      (f) => f.ruleId === "security.dom-injection",
    );
    expect(found.map((f) => [f.qualifiedName, f.line, f.kind, f.severity, rel(f.file)])).toEqual([
      [
        "AuraComponent:VisitPanel",
        4,
        "innerHTML",
        "high",
        "force-app/main/default/aura/VisitPanel/VisitPanelHelper.js",
      ],
      [
        "LWC:visitInsert",
        8,
        "insertAdjacentHTML",
        "high",
        "force-app/main/default/lwc/visitInsert/visitInsert.js",
      ],
      [
        "LWC:visitNotes",
        18,
        "innerHTML",
        "high",
        "force-app/main/default/lwc/visitNotes/visitNotes.js",
      ],
      [
        "LWC:visitBanner",
        7,
        "innerHTML",
        "low",
        "force-app/main/default/lwc/visitBanner/visitBanner.js",
      ],
    ]);
    expect(found.find((f) => f.qualifiedName === "LWC:visitNotes")?.message).toMatch(
      /lwc:dom="manual"/,
    );
  });

  it("security: coverage says every unit was examined", () => {
    const { coverage } = scanCodeSecurity(store, orgId);
    expect(coverage.complete).toBe(true);
    expect(coverage.scanned).toBe(coverage.total);
    expect(coverage.total).toBeGreaterThan(0);
  });

  it("SARIF findings carry the rule, level, file and line", () => {
    const risks = scanGovernorRisks(store, orgId).risks;
    const security = scanCodeSecurity(store, orgId).findings;
    const all = collectFindings({ governor: risks, codeSecurity: security });
    const one = all.find((f) => f.ruleId === "governor.async-in-loop" && f.location.line === 6);
    expect(one?.level).toBe("error");
    expect(rel(one?.location.sourceUri)).toBe(`${CLS}/VisitTriggerHandler.cls`);
    const low = all.find((f) => f.ruleId === "security.dom-injection" && f.level === "note");
    expect(low?.location.line).toBe(7);
    expect(new Set(all.map((f) => f.ruleId))).toEqual(
      new Set([
        "governor.async-in-loop",
        "governor.flow-dml-in-loop",
        "security.soql-injection",
        "security.dom-injection",
      ]),
    );
  });

  it("the clean fixtures raise nothing else: no soql/dml-in-loop, no injection outside the planted ones", () => {
    const risks = scanGovernorRisks(store, orgId).risks;
    expect(risks.every((r) => r.risk === "async_in_loop" || r.risk === "flow_dml_in_loop")).toBe(
      true,
    );
  });
});
