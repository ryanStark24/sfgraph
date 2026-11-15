import { describe, expect, it } from "vitest";
import { detectSoqlInjection } from "../soql-injection.js";
import { detectSoqlInjection as parentDetect } from "./_soql-injection-parent.js";

/**
 * The flow-sensitive analysis may drop a finding the parent (flow-insensitive, release/1.9.0 at
 * bb00bc5) reported only for the intended false-positive fixes listed in ALLOWED. Every other
 * case must report at least what the parent reported.
 */
const ALLOWED = [
  "numeric-valueOf", // String.format(Integer.valueOf(term)) and kin: a conversion is safe per argument
  "straight-line-sanitizer", // v = term; v = escapeSingleQuotes(v); in straight-line code
  "typed-param", // System.Integer style types
  "describe-per-argument", // describe-derived exempts only its own argument
  "map-value", // Map<K, Integer>.get(k)
] as const;
type Allowed = (typeof ALLOWED)[number];

interface Case {
  name: string;
  code: string;
  params?: string[];
  /** The parent reports this but the new analysis intentionally does not. */
  fixes?: Allowed;
}

const T = ["String term"];
const q = (e: string): string =>
  `return Database.query('SELECT Id FROM A WHERE N = \\'' + ${e} + '\\'');`;
const fmt = (arg: string): string =>
  `\nreturn Database.query(String.format('SELECT Id FROM A WHERE N = {0}', ${arg}));`;

const CASES: Case[] = [
  { name: "direct", code: `\n${q("term")}` },
  { name: "built variable", code: `\nString s = 'a' + term;\n${q("s")}` },
  { name: "+= append", code: `\nString s = 'a';\ns += term;\n${q("s")}` },
  { name: "valueOf of a String", code: `\n${q("String.valueOf(term)")}` },
  { name: "param appended", code: `\nterm += '%';\n${q("term")}` },
  { name: "ternary", code: `\n${q("(term == null ? 'x' : term)")}` },
  { name: "method on param", code: `\n${q("term.trim()")}` },
  { name: "format list of String param", code: fmt("new List<String>{ term }") },
  {
    name: "format String.valueOf of String",
    code: fmt("new List<String>{ String.valueOf(term) }"),
  },
  {
    name: "format sibling of escaped",
    code: fmt("new List<String>{ String.escapeSingleQuotes(term), term }"),
  },
  {
    name: "format copy constructor",
    code: fmt("new List<String>(terms)"),
    params: ["List<String> terms"],
  },
  {
    name: "format indexed",
    code: fmt("new List<String>{ terms[0] }"),
    params: ["List<String> terms"],
  },
  {
    name: "format get",
    code: fmt("new List<String>{ terms.get(0) }"),
    params: ["List<String> terms"],
  },
  { name: "format parenthesised list", code: fmt("(new List<String>{ term })") },
  {
    name: "format doubly parenthesised copy",
    code: fmt("((new List<String>(terms)))"),
    params: ["List<String> terms"],
  },
  { name: "format list variable", code: `\nList<String> a = new List<String>{ term };${fmt("a")}` },
  {
    name: "valueOf concat from list index",
    code: `\n${q("terms[0]")}`,
    params: ["List<String> terms"],
  },
  {
    name: "map of strings",
    code: `\n${q("String.valueOf(m.get(k))")}`,
    params: ["Map<String, String> m", "String k"],
  },
  // earlier review cases
  {
    name: "countQuery in RHS",
    code: "\nString q = term;\nq = String.valueOf(Database.countQuery(q));",
  },
  {
    name: "loop-carried",
    code: "\nString q = 'SELECT Id FROM Account';\nfor (Integer i = 0; i < 2; i++) { Database.query(q); q = term; }",
  },
  {
    name: "loop-carried while",
    code: "\nString q = 'SELECT Id FROM Account';\nwhile (more) { Database.query(q); q = term; q = String.escapeSingleQuotes(q); }",
    params: ["String term", "Boolean more"],
  },
  {
    name: "loop-carried do-while",
    code: "\nString q = 'SELECT Id FROM Account';\ndo { Database.query(q); q = term; } while (false);",
  },
  {
    name: "for update clause",
    code: "\nString q = term;\nfor (Integer i = 0; i < 0; q = 'SELECT Id FROM Account') { i++; }\nDatabase.query(q);",
  },
  {
    name: "for init under braceless if",
    code: "\nString q = term;\nif (flag) for (q = 'SELECT Id FROM Account'; false; ) { }\nDatabase.query(q);",
    params: ["String term", "Boolean flag"],
  },
  {
    name: "query in a while condition with a body assignment",
    code: "\nString q = 'SELECT Id FROM Account';\nwhile (Database.query(q).size() > 0) { q = term; }",
  },
  {
    name: "query in a for condition with a body assignment",
    code: "\nString q = 'SELECT Id FROM Account';\nfor (Integer i = 0; Database.query(q).size() > i; i++) { q = term; }",
  },
  {
    name: "reverse-order aliases carried by a loop",
    code: "\nString a = 'x';\nString b = 'y';\nfor (Integer i = 0; i < 2; i++) { Database.query(a); a = b; b = term; }",
  },
  {
    name: "conditional safe assignment",
    code: `\nString value = term;\nif (flag) { value = 'x'; }\n${q("value")}`,
    params: ["String term", "Boolean flag"],
  },
  {
    name: "braceless conditional safe assignment",
    code: `\nString value = term;\nif (flag) value = 'x';\n${q("value")}`,
    params: ["String term", "Boolean flag"],
  },
  {
    name: "tainted in a branch after a safe one",
    code: `\nString value = 'a';\nif (flag) { value = term; }\n${q("value")}`,
    params: ["String term", "Boolean flag"],
  },
  {
    name: "assignment after the call",
    code: `\nString value = term;\n${q("value")}\nvalue = 'x';`,
  },
  {
    name: "sanitiser in a branch only",
    code: `\nString value = term;\nif (flag) { value = String.escapeSingleQuotes(value); }\n${q("value")}`,
    params: ["String term", "Boolean flag"],
  },
  // intended false-positive fixes
  {
    name: "sanitiser reassign, straight line",
    code: `\nString value = term;\nvalue = String.escapeSingleQuotes(value);\n${q("value")}`,
    fixes: "straight-line-sanitizer",
  },
  {
    name: "literal reassign, straight line",
    code: `\nString value = term;\nvalue = 'fixed';\n${q("value")}`,
    fixes: "straight-line-sanitizer",
  },
  {
    name: "alias chain sanitised in the middle",
    code: `\nString a = term;\nString b = a;\nb = String.escapeSingleQuotes(b);\nString c = b;\n${q("c")}`,
    fixes: "straight-line-sanitizer",
  },
  {
    name: "format Integer.valueOf(term)",
    code: fmt("new List<String>{ String.valueOf(Integer.valueOf(term)) }"),
    fixes: "numeric-valueOf",
  },
  {
    name: "format Decimal.valueOf(term)",
    code: fmt("new List<String>{ String.valueOf(Decimal.valueOf(term)) }"),
    fixes: "numeric-valueOf",
  },
  {
    name: "format escapeSingleQuotes argument",
    code: fmt("new List<String>{ String.escapeSingleQuotes(term) }"),
  },
  {
    name: "format describe argument",
    code: fmt("new List<String>{ Schema.SObjectType.Account.getName() }"),
  },
  {
    // The parent exempted the whole format call when a describe call sat in it.
    name: "format describe beside an unescaped argument",
    code: fmt("new List<String>{ Schema.SObjectType.Account.getName(), term }"),
  },
  {
    name: "System.Integer parameter",
    code: `\n${q("String.valueOf(n)")}`,
    params: ["System.Integer n"],
    fixes: "typed-param",
  },
  {
    name: "Map<String, Integer> read",
    code: `\n${q("String.valueOf(caps.get(k))")}`,
    params: ["Map<String, Integer> caps", "String k"],
    fixes: "map-value",
  },
];

// Typed values through every shape: plain types stayed silent in the parent, `System.` ones did not.
const TYPES = ["Integer", "Long", "Decimal", "Double", "Boolean", "Id", "Date", "Datetime", "Time"];
for (const type of TYPES) {
  CASES.push({
    name: `${type} param through valueOf`,
    code: `\n${q("String.valueOf(x)")}`,
    params: [`${type} x`],
  });
  CASES.push({
    name: `System.${type} param through format`,
    code: fmt("new List<String>{ String.valueOf(x) }"),
    params: [`System.${type} x`],
    fixes: "typed-param",
  });
}

describe("flow-sensitive SOQL injection check against the flow-insensitive parent", () => {
  it("only the allow-listed fixes differ", () => {
    expect(ALLOWED).toHaveLength(5);
  });

  for (const c of CASES) {
    it(`${c.name}${c.fixes ? ` (fixes: ${c.fixes})` : ""}`, () => {
      const opts = { params: c.params ?? T };
      const before = parentDetect(c.code, opts);
      const after = detectSoqlInjection(c.code, opts);
      const key = (s: { line: number; kind: string }): string => `${s.line}:${s.kind}`;
      const afterKeys = new Set(after.map(key));
      const missing = before.filter((s) => !afterKeys.has(key(s)));
      if (c.fixes) {
        // The parent was wrong here: it reported, the new analysis must not.
        expect(before.length).toBeGreaterThan(0);
        expect(after).toEqual([]);
      } else {
        expect(missing).toEqual([]);
      }
    });
  }

  it("never reports in a case the parent did not, except as noted", () => {
    // The one intended addition: `terms[0]` on a tainted collection (the parent's known gap).
    for (const c of CASES) {
      const opts = { params: c.params ?? T };
      const before = parentDetect(c.code, opts).length;
      const after = detectSoqlInjection(c.code, opts).length;
      if (after > before) expect(c.name).toBe("valueOf concat from list index");
    }
  });
});
