import { ConsoleLogger } from "@sfgraph/shared";
import { describe, expect, it } from "vitest";
import type { ParseContext } from "../../contract.js";
import { RuleBasedParser } from "../_engine.js";
import { RuleSchema } from "../_schema.js";

function makeCtx(): ParseContext {
  return {
    orgId: "org_test",
    sourceUri: "test://uri",
    parseTimestamp: "2026-01-01T00:00:00Z",
    namespace: null,
    logger: new ConsoleLogger("error"),
  };
}

function build(rule: unknown): RuleBasedParser {
  return new RuleBasedParser(RuleSchema.parse(rule));
}

describe("RuleBasedParser engine", () => {
  it("emits zero output for an empty rule", async () => {
    const p = build({
      type: "Empty",
      category: "Profile",
      input: "object",
      applies_when: { always: true },
    });
    const r = await p.parse({}, makeCtx());
    expect(r.nodes).toEqual([]);
    expect(r.edges).toEqual([]);
  });

  it("emits a single node with materialized props", async () => {
    const p = build({
      type: "Foo",
      category: "Profile",
      input: "object",
      applies_when: { always: true },
      nodes: [
        { label: "Foo", qname: "Foo:${record.id}", props: { id: "${record.id}", active: true } },
      ],
    });
    const r = await p.parse({ id: "abc" }, makeCtx());
    expect(r.nodes.length).toBe(1);
    const n = r.nodes[0];
    expect(n?.label).toBe("Foo");
    expect(String(n?.qualifiedName)).toBe("Foo:abc");
    expect(n?.attributes?.id).toBe("abc");
    expect(n?.attributes?.active).toBe(true);
  });

  it("iterates and produces N edges", async () => {
    const p = build({
      type: "Bar",
      category: "Profile",
      input: "object",
      applies_when: { always: true },
      nodes: [{ label: "Bar", qname: "Bar:${record.id}" }],
      edges: [
        {
          relType: "REFERENCES",
          iterate: "${record.children}",
          src: "Bar:${record.id}",
          dst: "Child:${item.name}",
        },
      ],
    });
    const r = await p.parse({ id: "x", children: [{ name: "a" }, { name: "b" }] }, makeCtx());
    expect(r.edges.length).toBe(2);
  });

  it("filters edges via `when`", async () => {
    const p = build({
      type: "Filt",
      category: "Profile",
      input: "object",
      applies_when: { always: true },
      edges: [
        {
          relType: "REFERENCES",
          iterate: "${record.items}",
          when: "${item.keep}",
          src: "X:1",
          dst: "Y:${item.name}",
        },
      ],
    });
    const r = await p.parse(
      {
        items: [
          { name: "a", keep: true },
          { name: "b", keep: false },
          { name: "c", keep: true },
        ],
      },
      makeCtx(),
    );
    expect(r.edges.length).toBe(2);
  });

  it("missing iterate produces zero edges (no throw)", async () => {
    const p = build({
      type: "Miss",
      category: "Profile",
      input: "object",
      applies_when: { always: true },
      edges: [
        {
          relType: "REFERENCES",
          iterate: "${record.nothing}",
          src: "A:1",
          dst: "B:${item.x}",
        },
      ],
    });
    const r = await p.parse({}, makeCtx());
    expect(r.edges).toEqual([]);
  });

  it("coerces primitives through props (boolean stays boolean)", async () => {
    const p = build({
      type: "Coerce",
      category: "Profile",
      input: "object",
      applies_when: { always: true },
      nodes: [
        {
          label: "Coerce",
          qname: "Coerce:1",
          props: { flag: "${record.flag}" },
        },
      ],
    });
    const r = await p.parse({ flag: true }, makeCtx());
    expect(r.nodes[0]?.attributes?.flag).toBe(true);
  });
});
