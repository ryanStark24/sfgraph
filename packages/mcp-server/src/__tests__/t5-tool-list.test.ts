import { afterEach, describe, expect, it, vi } from "vitest";
import { SfgraphMcpServer } from "../server.js";
import { CORE_TOOLS, toolList, toolProfile } from "../tool-registry.js";

/**
 * Cycle 3 T5: every agent pays for tools/list on every call, so the list has a size budget:
 * description + JSON.stringify(inputSchema) per tool, measured on toolList, the function the
 * server's tools/list handler returns. SFGRAPH_TOOLS=core serves only the keyed tools.
 */
async function loaded(profile?: "full" | "core") {
  const s = new SfgraphMcpServer(profile ? { profile } : {});
  s.registerDefaults();
  await s.loadAllTools();
  return s;
}

const size = (list: { description: string; inputSchema: unknown }[]) =>
  list.reduce((n, t) => n + t.description.length + JSON.stringify(t.inputSchema).length, 0);

// The 18 keyed tools of bench/tool-tests/cases (directory names). find_nodes and explain_code are
// among them. A new core tool is a conscious change to this list.
const KEYED = [
  "analyze_field",
  "cross_layer_flow_map",
  "cross_org_diff",
  "dead_code_audit",
  "explain_code",
  "find_nodes",
  "find_similar",
  "governor_risk_check",
  "impact_from_git_diff",
  "point_in_time_diff",
  "security_audit",
  "test_gap_intelligence_from_git_diff",
  "trace_downstream",
  "trace_upstream",
  "what_broke",
  "wip_diff",
  "wip_impact",
  "wip_test_gap",
];

describe("tools/list size budget", () => {
  it("the full list is at most 10,000 characters", async () => {
    const s = await loaded("full");
    const list = toolList(s.registry, "full");
    expect(list.length).toBe(s.registry.list().length);
    expect(size(list)).toBeLessThanOrEqual(10000);
  });

  it("the core list is at most 7,000 characters and holds exactly the keyed tools", async () => {
    const s = await loaded("core");
    const list = toolList(s.registry, "core");
    expect(list.map((t) => t.name).sort()).toEqual(KEYED);
    expect([...CORE_TOOLS]).toEqual(KEYED);
    expect(size(list)).toBeLessThanOrEqual(7000);
  });

  it("core and full use the same descriptions and schemas", async () => {
    const s = await loaded();
    const full = new Map(toolList(s.registry, "full").map((t) => [t.name, t]));
    for (const t of toolList(s.registry, "core")) expect(t).toEqual(full.get(t.name));
  });

  it("the tools/list handler returns toolList for the server's profile", async () => {
    const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
    const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
    for (const profile of ["full", "core"] as const) {
      const s = new SfgraphMcpServer({ profile });
      s.registerDefaults();
      const server = await s.createSdkServer();
      const [a, b] = InMemoryTransport.createLinkedPair();
      const client = new Client({ name: "t", version: "0" });
      await Promise.all([server.connect(a), client.connect(b)]);
      const { tools } = await client.listTools();
      expect(tools).toEqual(toolList(s.registry, profile));
      await client.close();
    }
  });
});

describe("SFGRAPH_TOOLS profile", () => {
  afterEach(() => vi.restoreAllMocks());

  it("unset or full means the full list; core means core", () => {
    const warn = vi.fn();
    expect(toolProfile(undefined, warn)).toBe("full");
    expect(toolProfile("", warn)).toBe("full");
    expect(toolProfile("full", warn)).toBe("full");
    expect(toolProfile("core", warn)).toBe("core");
    expect(toolProfile(" CORE ", warn)).toBe("core");
    expect(warn).not.toHaveBeenCalled();
  });

  it("an unknown value means the full list and logs one warning line to stderr", () => {
    const write = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    expect(toolProfile("minimal")).toBe("full");
    expect(write).toHaveBeenCalledTimes(1);
    const line = String(write.mock.calls[0]![0]);
    expect(line).toMatch(/SFGRAPH_TOOLS/);
    expect(line).toMatch(/minimal/);
    expect(line.endsWith("\n")).toBe(true);
    expect(line.trimEnd().includes("\n")).toBe(false);
  });

  it("the server reads SFGRAPH_TOOLS when no profile is given", () => {
    const prev = process.env.SFGRAPH_TOOLS;
    try {
      process.env.SFGRAPH_TOOLS = "core";
      expect(new SfgraphMcpServer().profile).toBe("core");
      Reflect.deleteProperty(process.env, "SFGRAPH_TOOLS");
      expect(new SfgraphMcpServer().profile).toBe("full");
    } finally {
      if (prev === undefined) Reflect.deleteProperty(process.env, "SFGRAPH_TOOLS");
      else process.env.SFGRAPH_TOOLS = prev;
    }
  });

  it("core refuses a tool it does not list, with a plain error", async () => {
    const s = await loaded("core");
    const r = await s.dispatch("ping", {});
    expect(r.isError).toBe(true);
    expect(r.content[0]!.text).toMatch(
      /^Could not run ping, because this server was started with SFGRAPH_TOOLS=core\. Try /,
    );
    const full = await loaded("full");
    expect((await full.dispatch("ping", {})).isError).toBeUndefined();
  });
});

type Schema = Record<string, unknown>;
const walk = (v: unknown, visit: (o: Schema) => void): void => {
  if (Array.isArray(v)) for (const x of v) walk(x, visit);
  else if (v && typeof v === "object") {
    visit(v as Schema);
    for (const x of Object.values(v)) walk(x, visit);
  }
};

/** A small JSON Schema check of the keywords the tool schemas use. Returns the problems found. */
function check(schema: Schema, value: unknown, at = "$"): string[] {
  if (Array.isArray(schema.anyOf))
    return (schema.anyOf as Schema[]).some((s) => check(s, value, at).length === 0)
      ? []
      : [`${at}: no anyOf branch matches`];
  const out: string[] = [];
  const t = schema.type;
  const is: Record<string, (v: unknown) => boolean> = {
    object: (v) => !!v && typeof v === "object" && !Array.isArray(v),
    array: Array.isArray,
    string: (v) => typeof v === "string",
    integer: Number.isInteger,
    number: (v) => typeof v === "number",
    boolean: (v) => typeof v === "boolean",
  };
  if (typeof t === "string" && !is[t]!(value)) return [`${at}: not ${t}`];
  if ("const" in schema && value !== schema.const) out.push(`${at}: not ${schema.const}`);
  if (Array.isArray(schema.enum) && !schema.enum.includes(value)) out.push(`${at}: not in enum`);
  if (typeof value === "string") {
    if (typeof schema.maxLength === "number" && value.length > schema.maxLength)
      out.push(`${at}: too long`);
    if (typeof schema.pattern === "string" && !new RegExp(schema.pattern).test(value))
      out.push(`${at}: pattern`);
  }
  if (typeof value === "number") {
    if (typeof schema.minimum === "number" && value < schema.minimum) out.push(`${at}: < min`);
    if (typeof schema.maximum === "number" && value > schema.maximum) out.push(`${at}: > max`);
  }
  if (Array.isArray(value) && schema.items)
    value.forEach((x, i) => out.push(...check(schema.items as Schema, x, `${at}[${i}]`)));
  if (t === "object") {
    const o = value as Record<string, unknown>;
    const props = (schema.properties ?? {}) as Record<string, Schema>;
    for (const r of (schema.required ?? []) as string[])
      if (!(r in o)) out.push(`${at}.${r}: required`);
    for (const [k, v] of Object.entries(o)) {
      if (!props[k]) out.push(`${at}.${k}: unknown option`);
      else out.push(...check(props[k]!, v, `${at}.${k}`));
    }
  }
  return out;
}

// The argument shapes the keyed tools are called with in their tool tests and the bench.
const DIFF = "diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1 +1 @@\n-a\n+b\n";
const ARGS: Record<string, Record<string, unknown>[]> = {
  analyze_field: [
    { org: "o", object: "Account", field: "Status__c" },
    { org: "o", object: "Account", field: "Name", include_grants: true, mermaid: false },
  ],
  cross_layer_flow_map: [
    { org: "o", entry: "LWC:caseCard" },
    { org: "o", entry: "Flow:F", mermaid: false },
  ],
  cross_org_diff: [
    { org_a: "a", org_b: "b" },
    { org_a: "a", org_b: "b", category: "apex" },
  ],
  dead_code_audit: [
    { org: "o" },
    { org: "o", label: "ApexClass", pattern: "*Handler", limit: 100, confidence: "high" },
  ],
  explain_code: [
    { org: "o", qname: "ApexMethod:BillingSvc.run(2)" },
    { org: "o", qname: "Flow:F", refresh: true, annotation: "x", mermaid: false },
  ],
  find_nodes: [
    { org: "o", pattern: "ApexClass:*" },
    { org: "o", pattern: "*:*Email*", label: "CustomField", limit: 50 },
  ],
  find_similar: [
    { org: "o", qname: "ApexClass:A" },
    { org: "o", text: "billing", k: 5, label: "ApexClass", min_similarity: 0.5 },
  ],
  governor_risk_check: [{ org: "o" }, { org: "o", limit: 100, includeTests: true }],
  impact_from_git_diff: [
    { org: "o", diff: DIFF },
    { org: "o", diff: DIFF, depth: 2, mermaid: false },
  ],
  point_in_time_diff: [
    { org: "o", from: "snap-1" },
    { org: "o", from: "snap-1", to: "current", limit: 50 },
    { org: "o", from: "snap-1", to: "snap-2" },
  ],
  security_audit: [
    { org: "o" },
    { org: "o", object: "Account", field: "SSN__c", include_non_fls_fields: true, limit: 10 },
  ],
  test_gap_intelligence_from_git_diff: [
    { org: "o", diff: DIFF },
    { org: "o", diff: DIFF, depth: 2 },
  ],
  trace_downstream: [
    { org: "o", qname: "ApexTrigger:CaseTrigger" },
    { org: "o", qname: "ApexClass:A", depth: 2, labels: ["ApexMethod"], include_structure: true },
  ],
  trace_upstream: [
    { org: "o", qname: "CustomField:Account.Name" },
    {
      org: "o",
      qname: "ApexClass:A",
      depth: 5,
      rel_types: ["CALLS"],
      include_security: true,
      include_inferred: true,
      mermaid: false,
    },
  ],
  what_broke: [{ org: "o" }, { org: "o", since: "snap-1", depth: 2, limit: 10, mermaid: false }],
  wip_diff: [
    { project_root: "/p", org: "o" },
    { project_root: "/p", org: "o", mode: "full-folder" },
  ],
  wip_impact: [
    { project_root: "/p", org: "o" },
    { project_root: "/p", org: "o", depth: 1, mode: "full-folder" },
  ],
  wip_test_gap: [{ project_root: "/p", org: "o", depth: 2 }],
};

describe("emitted input schemas", () => {
  it("carry no boilerplate: additionalProperties false, empty defaults, minLength 1", async () => {
    const s = await loaded();
    const hits: string[] = [];
    for (const t of toolList(s.registry, "full"))
      walk(t.inputSchema, (o) => {
        if (o.additionalProperties === false) hits.push(`${t.name} additionalProperties`);
        if ("$schema" in o) hits.push(`${t.name} $schema`);
        if (o.minLength === 1) hits.push(`${t.name} minLength`);
        if ("default" in o && [false, ""].includes(o.default as never))
          hits.push(`${t.name} default`);
        if (Array.isArray(o.default) && o.default.length === 0) hits.push(`${t.name} default []`);
      });
    expect(hits).toEqual([]);
  });

  it("hold no $ref without its definition", async () => {
    const s = await loaded();
    for (const t of toolList(s.registry, "full")) {
      const text = JSON.stringify(t.inputSchema);
      if (text.includes('"$ref"'))
        expect((t.inputSchema as Schema).definitions, `${t.name} $ref`).toBeDefined();
    }
  });

  it("keep required, enum, numeric bounds and types", async () => {
    const s = await loaded();
    const get = (n: string) =>
      toolList(s.registry, "full").find((t) => t.name === n)!.inputSchema as {
        type: string;
        required: string[];
        properties: Record<string, Schema>;
      };
    const up = get("trace_upstream");
    expect(up.type).toBe("object");
    expect(up.required).toEqual(["org", "qname"]);
    expect(up.properties.depth).toEqual({ type: "integer", minimum: 1, maximum: 5, default: 3 });
    expect(up.properties.org).toEqual({ type: "string" });
    expect(up.properties.mermaid).toEqual({ type: "boolean", default: true });
    expect(get("wip_impact").properties.mode).toEqual({
      type: "string",
      enum: ["changed-only", "full-folder"],
      default: "changed-only",
    });
    expect(get("point_in_time_diff").properties.to).toEqual({ type: "string", default: "current" });
    expect(get("start_ingest_job").properties.source).toBeDefined();
    expect(JSON.stringify(get("start_ingest_job"))).not.toContain("$ref");
  });

  it("accept the keyed tools' real argument shapes", async () => {
    const s = await loaded("core");
    const list = toolList(s.registry, "core");
    expect(Object.keys(ARGS).sort()).toEqual(KEYED);
    for (const t of list)
      for (const a of ARGS[t.name]!)
        expect(check(t.inputSchema as Schema, a), `${t.name} ${JSON.stringify(a)}`).toEqual([]);
  });

  // Cycle 3 T5 fix 1 (M1): with the caching note gone from the description, the option says it.
  it("explain_code's annotation option says it saves the explanation", async () => {
    const s = await loaded();
    const ex = toolList(s.registry, "core").find((t) => t.name === "explain_code")!.inputSchema as {
      properties: Record<string, Schema>;
    };
    expect(String(ex.properties.annotation!.description)).toMatch(/saves?/i);
  });

  it("an empty string for a required name is still refused by the handler", async () => {
    const s = await loaded();
    for (const [name, args] of [
      ["trace_upstream", { org: "o", qname: "" }],
      ["find_nodes", { org: "", pattern: "ApexClass:*" }],
      ["analyze_field", { org: "o", object: "", field: "Name" }],
    ] as const) {
      const r = await s.dispatch(name, args);
      expect(r.isError, name).toBe(true);
      expect(r._meta?.code, name).toBe("INVALID_INPUT");
    }
  });
});
