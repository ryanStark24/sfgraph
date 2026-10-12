import { describe, expect, it } from "vitest";
import { plainKind } from "../_plain.js";
import {
  HEADINGS,
  type HumanReport,
  type Piece,
  aOrAn,
  andList,
  countOf,
  kindCounts,
  linkFacts,
  linkLines,
  listWithMore,
  notCountedPhrase,
  pieceRole,
  renderReport,
  reportDiagram,
  testSplit,
} from "../_report.js";
import { lint, section } from "./_jargon.js";

// Cycle 3 T2: the report builder every tool uses for its result text.
const pieces = (n: number): Piece[] =>
  Array.from({ length: n }, (_, i) => ({
    name: `Svc${String(i).padStart(2, "0")}`,
    kind: "ApexClass",
    role: pieceRole({ kind: "ApexClass", callers: ["ApexTrigger:CaseTrigger"] }),
  }));

const base = (): HumanReport => ({
  title: "What `CaseTrigger` depends on",
  inShort: [
    `\`CaseTrigger\` relies on 3 other pieces: 2 ${plainKind("ApexClass", { plural: true })} and 1 ${plainKind("CustomField")}.`,
    "Nothing it reaches is managed-package code.",
  ],
  diagram: reportDiagram(
    [
      { id: "ApexTrigger:CaseTrigger", label: "ApexTrigger" },
      { id: "ApexClass:CaseService", label: "ApexClass" },
      { id: "CustomField:Case.Status", label: "CustomField" },
    ],
    [
      { from: "ApexTrigger:CaseTrigger", to: "ApexClass:CaseService", rel: "CALLS" },
      { from: "ApexClass:CaseService", to: "CustomField:Case.Status", rel: "WRITES_FIELD" },
    ],
  ),
  pieces: pieces(3),
  details: "- ApexClass:CaseService\n- ApexClass:CaseHelper\n- CustomField:Case.Status",
  next: ["To see the fields inside objects, call again with `include_structure: true`."],
});

describe("renderReport", () => {
  it("emits the sections in the fixed order with the fixed headings", () => {
    const out = renderReport(base());
    const lines = out.split("\n");
    expect(lines[0]).toBe("## What `CaseTrigger` depends on");
    const order = [
      "**In short**",
      "**Picture**",
      "**What each piece does**",
      "**Technical details**",
      "**What to check next**",
    ].map((h) => lines.indexOf(h));
    expect(order.every((i) => i > 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(out).toContain("```mermaid\nflowchart LR\n");
    expect(section(out, "Technical details")).toBe(base().details);
  });

  it("leaves out Picture, pieces and next steps when they are absent", () => {
    const r = base();
    r.diagram = undefined;
    r.pieces = [];
    r.next = [];
    const out = renderReport(r);
    expect(out).not.toContain("**Picture**");
    expect(out).not.toContain("**What each piece does**");
    expect(out).not.toContain("**What to check next**");
    expect(out).toContain("**In short**");
    expect(out).toContain("**Technical details**");
  });

  it("caps pieces at 15 lines and counts the rest", () => {
    const out = renderReport({ ...base(), pieces: pieces(27) });
    const body = section(out, "What each piece does")!.split("\n");
    expect(body.filter((l) => l.startsWith("- `Svc"))).toHaveLength(15);
    expect(body.at(-1)).toBe("- and 12 more, listed under Technical details");
  });

  it("piece lines show the API name in code style and no raw qname", () => {
    const out = renderReport({
      ...base(),
      pieces: [
        {
          name: "ApexClass:CaseService",
          kind: "ApexClass",
          role: "role not recorded in the graph",
        },
      ],
    });
    const body = section(out, "What each piece does")!;
    expect(body).toContain("`CaseService`");
    expect(lint(body)).toEqual([]);
  });

  // Fix round 1 M-2: only a label prefix is dropped; a namespace such as `c:` stays.
  it("drops a label prefix from a piece name but keeps a lowercase namespace", () => {
    const out = renderReport({
      ...base(),
      pieces: [
        { name: "c:caseForm", kind: "AuraComponent", role: "r" },
        { name: "EntityFilter:Active_Cases", kind: "EntityFilter", role: "r" },
      ],
    });
    const body = section(out, "What each piece does")!;
    expect(body).toContain("- `c:caseForm`: ");
    expect(body).toContain("- `Active_Cases`: ");
  });

  // Fix round 1 M-3: a newline inside a role or In short line cannot break a section's shape.
  it("keeps every piece and In short on one line when the text holds newlines", () => {
    const out = renderReport({
      ...base(),
      inShort: ["First\nsentence.", "Second  \n  one."],
      pieces: [
        { name: "A\nB", kind: "ApexClass", role: "Apex class (server code),\ncalled by `X`." },
        { name: "C", kind: "ApexClass", role: "r" },
      ],
    });
    expect(section(out, "In short")).toBe("First sentence. Second one.");
    const body = section(out, "What each piece does")!.split("\n");
    expect(body).toEqual([
      "- `A B`: Apex class (server code), called by `X`.",
      // Cycle 3 T3 fix round 1 (M4): a kind is glossed on first use only (in the pieces).
      "- `C`: Apex class: r",
    ]);
  });

  it("In short and pieces pass the jargon list", () => {
    const out = renderReport({ ...base(), pieces: pieces(20) });
    expect(lint(section(out, "In short")!)).toEqual([]);
    expect(lint(section(out, "What each piece does")!)).toEqual([]);
  });

  it("is deterministic for the same input", () => {
    expect(renderReport(base())).toBe(renderReport(base()));
  });
});

describe("pieceRole", () => {
  it("writes one plain sentence from the facts", () => {
    expect(
      pieceRole({
        kind: "ApexClass",
        callers: ["ApexTrigger:CaseTrigger"],
        callees: ["ApexClass:CaseService"],
      }),
    ).toBe("Apex class (server code), called by `CaseTrigger`; it calls `CaseService`.");
  });

  it("caps callers and callees at 3 each", () => {
    const r = pieceRole({
      kind: "Flow",
      callers: ["A", "B", "C", "D", "E"],
      callees: ["ApexClass:W", "ApexClass:X", "ApexClass:Y", "ApexClass:Z"],
    });
    expect(r).toContain("called by `A`, `B`, `C` and 2 others");
    expect(r).toContain("it calls `W`, `X`, `Y` and 1 other");
  });

  it("names the link that reached it", () => {
    expect(pieceRole({ kind: "CustomField", via: "WRITES_FIELD" })).toContain('"writes the field"');
  });

  it("says the role is not recorded when there are no facts", () => {
    expect(pieceRole({ kind: "" })).toBe("role not recorded in the graph.");
    expect(pieceRole({ kind: "ApexClass" })).toBe(
      "Apex class (server code); role not recorded in the graph.",
    );
  });

  it("passes the jargon list", () => {
    expect(lint(pieceRole({ kind: "ApexMethod", via: "CONTAINS_METHOD", callers: ["X"] }))).toEqual(
      [],
    );
  });
});

describe("reportDiagram", () => {
  const n = (id: string, label: string) => ({ id, label });

  it("returns undefined for 2 or fewer components in one layer", () => {
    expect(reportDiagram([], [])).toBeUndefined();
    expect(reportDiagram([n("ApexClass:A", "ApexClass")], [])).toBeUndefined();
    expect(
      reportDiagram(
        [n("ApexClass:A", "ApexClass"), n("ApexClass:B", "ApexClass")],
        [{ from: "ApexClass:A", to: "ApexClass:B", rel: "CALLS" }],
      ),
    ).toBeUndefined();
  });

  it("draws 2 components when they are in different layers", () => {
    const d = reportDiagram(
      [n("LWC:caseForm", "LWC"), n("ApexClass:CaseCtl", "ApexClass")],
      [{ from: "LWC:caseForm", to: "ApexClass:CaseCtl", rel: "CALLS_APEX_FROM_LWC" }],
    );
    expect(d).toBeDefined();
  });

  it("draws 3 components with Kind: Name text, safe ids and plain link words", () => {
    const d = reportDiagram(
      [
        n("ApexTrigger:CaseTrigger", "ApexTrigger"),
        n('ApexClass:Case"Svc', "ApexClass"),
        n("ApexMethod:Svc.run(2)", "ApexMethod"),
      ],
      [
        { from: "ApexTrigger:CaseTrigger", to: 'ApexClass:Case"Svc', rel: "CALLS" },
        { from: 'ApexClass:Case"Svc', to: "ApexMethod:Svc.run(2)", rel: "CONTAINS_METHOD" },
        { from: 'ApexClass:Case"Svc', to: "ApexClass:Missing", rel: "CALLS" },
      ],
    )!;
    const lines = d.split("\n");
    expect(lines[0]).toBe("flowchart LR");
    expect(d).toContain('n0["Apex trigger: CaseTrigger"]');
    expect(d).toContain('n1["Apex class: Case#quot;Svc"]');
    expect(d).toContain('n2["Apex method: Svc.run(2)"]');
    expect(d).toContain("n0 -->|calls| n1");
    // Cycle 3 T3 fix round 1 (M3): containment is a dotted link.
    expect(d).toContain("n1 -.->|has the method| n2");
    expect(d).not.toMatch(/Missing/);
    for (const m of d.matchAll(/^\s*(\w+)\[/gm)) expect(m[1]).toMatch(/^n\d+$/);
  });

  it("keeps the nodes nearest the first node when over the cap, and counts the rest", () => {
    // A chain n0 - n1 - ... - n39, given in reverse order after the first node.
    const ids = Array.from({ length: 40 }, (_, i) => `ApexClass:C${i}`);
    const nodes = [ids[0]!, ...ids.slice(1).reverse()].map((id) => n(id, "ApexClass"));
    const edges = ids.slice(1).map((id, i) => ({ from: ids[i]!, to: id, rel: "CALLS" }));
    const d = reportDiagram(nodes, edges, { max: 10 })!;
    const texts = [...d.matchAll(/\["Apex class: (C\d+)"\]/g)].map((m) => m[1]);
    expect(texts).toEqual(Array.from({ length: 10 }, (_, i) => `C${i}`));
    expect(d).toContain('["and 30 more"]');
    expect(reportDiagram(nodes, edges)!.match(/\["Apex class:/g)).toHaveLength(25);
  });

  it("is deterministic", () => {
    const args = [
      [n("A:x", "ApexClass"), n("B:y", "Flow"), n("C:z", "CustomField")],
      [{ from: "A:x", to: "B:y", rel: "X_Y" }],
    ] as const;
    expect(reportDiagram([...args[0]], [...args[1]])).toBe(
      reportDiagram([...args[0]], [...args[1]]),
    );
  });
});

// Cycle 3 T3: the shared helpers the trace, impact and flow reports are written with.
describe("report helpers (cycle 3 T3)", () => {
  it("andList and listWithMore join and cut lists in plain words", () => {
    expect(andList(["a"])).toBe("a");
    expect(andList(["a", "b", "c"])).toBe("a, b and c");
    expect(listWithMore(["a", "b", "c", "d"], 2)).toBe("a, b and 2 more");
    expect(listWithMore(["a", "b"], 2)).toBe("a, b");
  });

  it("kindCounts counts kinds largest first and folds the rest", () => {
    expect(kindCounts(["CustomField", "ApexClass", "ApexClass"])).toBe(
      "2 Apex classes (server code) and 1 field",
    );
    expect(kindCounts(["Flow", "LWC", "CustomField", "ApexClass", "Profile"], 3)).toBe(
      "1 Apex class (server code), 1 field and 3 other pieces",
    );
    expect(countOf(2, "CustomObject")).toBe("2 objects (tables of records)");
  });

  it("notCountedPhrase names each kind of not-counted endpoint in plain words", () => {
    const t = notCountedPhrase(["dml", "apex-platform", "apex-platform"]);
    expect(t).toBe("2 calls to built-in Salesforce code and 1 record save or delete");
    expect(lint(t)).toEqual([]);
  });

  it("linkFacts splits links into calls and other uses, both ways", () => {
    const facts = linkFacts(
      [
        { from: "ApexClass:A", to: "ApexClass:B", rel: "CALLS" },
        { from: "ApexClass:B", to: "CustomField:X.F__c", rel: "READS_FIELD" },
        { from: "ApexClass:B", to: "Ghost:Z", rel: "CALLS" },
      ],
      new Set(["ApexClass:A", "ApexClass:B", "CustomField:X.F__c"]),
    );
    expect(facts("ApexClass:B")).toEqual({
      name: "ApexClass:B",
      callers: ["ApexClass:A"],
      usedBy: [],
      into: [],
      callees: [],
      does: [{ rel: "READS_FIELD", names: ["CustomField:X.F__c"] }],
    });
    expect(facts("CustomField:X.F__c").usedBy).toEqual(["ApexClass:B"]);
    expect(facts("CustomField:X.F__c").into).toEqual([
      { rel: "READS_FIELD", names: ["ApexClass:B"] },
    ]);
    expect(pieceRole({ kind: "ApexClass", ...facts("ApexClass:B") })).toBe(
      "Apex class (server code), called by `A`; it reads the field `X.F__c`.",
    );
  });

  it("linkLines writes one full-name line per link, capped with a count", () => {
    const e = [
      { from: "ApexClass:A", to: "ApexClass:B", rel: "CALLS" },
      { from: "ApexClass:A", to: "ApexClass:B", rel: "CALLS" },
      { from: "ApexClass:B", to: "ApexClass:C" },
    ];
    expect(linkLines(e)).toEqual([
      "- ApexClass:A -> ApexClass:B (CALLS)",
      "- ApexClass:B -> ApexClass:C",
    ]);
    expect(linkLines(e, 1)).toEqual([
      "- ApexClass:A -> ApexClass:B (CALLS)",
      "- _and 1 more (narrow the call to see them)_",
    ]);
  });

  // Fix round 1.
  it("aOrAn picks the article from the sound of the word", () => {
    expect(aOrAn("Apex trigger")).toBe("an Apex trigger");
    expect(aOrAn("OmniScript")).toBe("an OmniScript");
    expect(aOrAn("field")).toBe("a field");
  });

  it("a plural kind takes a plural gloss", () => {
    expect(countOf(2, "CustomObject")).toBe("2 objects (tables of records)");
    expect(countOf(3, "LWC")).toBe("3 Lightning web components (screen parts)");
    expect(countOf(2, "Profile")).toBe("2 profiles (a user's base permissions)");
    expect(countOf(2, "ApexClass")).toBe("2 Apex classes (server code)");
  });

  it("pieceRole names incoming links by what they do; a field names its object", () => {
    expect(
      pieceRole({
        kind: "CustomField",
        name: "CustomField:Case.Priority__c",
        into: [
          { rel: "READS_FIELD", names: ["ApexClass:Svc"] },
          { rel: "DEFINES_FIELD", names: ["CustomObject:Case"] },
        ],
      }),
    ).toBe("Field on `Case`, read by `Svc`.");
    expect(
      pieceRole({
        kind: "CustomObject",
        name: "CustomObject:Case",
        into: [{ rel: "TRIGGERS_ON", names: ["ApexTrigger:T"] }],
      }),
    ).toBe("Object (a table of records); the trigger `T` runs when `Case` records change.");
    expect(pieceRole({ kind: "CustomField", name: "CustomField:Case.F__c" })).toBe(
      "Field on `Case`.",
    );
  });

  it("renderReport glosses each kind once, In short first", () => {
    const md = renderReport({
      title: "t",
      inShort: ["It adds 1 Apex class (server code) and changes 2 Apex classes (server code)."],
      pieces: [{ name: "ApexClass:A", kind: "ApexClass", role: "Apex class (server code)." }],
      details: "x (server code)",
    });
    // Fix round 2: In short and the pieces each gloss on their own first use.
    expect(md.slice(0, md.indexOf(HEADINGS.details)).match(/\(server code\)/g)).toHaveLength(2);
    expect(md).toContain("It adds 1 Apex class (server code) and changes 2 Apex classes.");
    expect(md).toContain("- `A`: Apex class (server code).");
    expect(md).toContain("x (server code)");
  });

  it("reportDiagram draws containment as a dotted link", () => {
    const d = reportDiagram(
      [
        { id: "ApexClass:A", label: "ApexClass" },
        { id: "CustomObject:Case", label: "CustomObject" },
        { id: "CustomField:Case.F__c", label: "CustomField" },
      ],
      [
        { from: "ApexClass:A", to: "CustomField:Case.F__c", rel: "READS_FIELD" },
        { from: "CustomObject:Case", to: "CustomField:Case.F__c", rel: "DEFINES_FIELD" },
      ],
    );
    expect(d).toContain("n0 -->|reads the field| n2");
    expect(d).toContain("n1 -.->|has the field| n2");
  });

  it("testSplit counts only non-test Apex classes and triggers as having no test", () => {
    expect(
      testSplit(
        { noTest: ["ApexTrigger"], covered: 1, tests: 1, notApplicable: ["Flow", "LWC"] },
        "tests",
      ),
    ).toBe(
      "1 Apex trigger (code that runs when records change) has no tests, 1 is covered by tests and 1 is a test class; 1 flow (point-and-click automation) and 1 Lightning web component (a screen part) cannot carry Apex test coverage",
    );
  });
});
