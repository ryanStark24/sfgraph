export interface ToolHandlerResult {
  [key: string]: unknown;
}

export type ToolHandler = (input: Record<string, unknown>) => Promise<ToolHandlerResult>;

export interface ToolSchema {
  description: string;
  inputSchema?: Record<string, unknown>;
}

export interface RegisteredTool {
  name: string;
  handler: ToolHandler;
  schema: ToolSchema;
}

export class ToolRegistry {
  private readonly tools = new Map<string, RegisteredTool>();

  register(name: string, handler: ToolHandler, schema: ToolSchema): void {
    if (this.tools.has(name)) {
      throw new Error(`tool '${name}' already registered`);
    }
    this.tools.set(name, { name, handler, schema });
  }

  get(name: string): RegisteredTool | undefined {
    return this.tools.get(name);
  }

  list(): RegisteredTool[] {
    return Array.from(this.tools.values());
  }

  clear(): void {
    this.tools.clear();
  }
}

/**
 * Global default registry. `defineTool` registers here on side-effect import.
 */
export const defaultRegistry = new ToolRegistry();

export function registerTool(spec: {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  execute: ToolHandler;
}): void {
  defaultRegistry.register(spec.name, spec.execute, {
    description: spec.description,
    inputSchema: spec.inputSchema,
  });
}

/**
 * Cycle 3 T5: the tools served with SFGRAPH_TOOLS=core, sorted: the 18 keyed tools of the bench
 * (bench/tool-tests/cases). Adding a tool here is a conscious choice; the size budget test holds
 * the list.
 */
export const CORE_TOOLS: readonly string[] = [
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

export type ToolProfile = "full" | "core";

/**
 * The tool profile from an SFGRAPH_TOOLS value: `core`, or `full` (also when unset or empty).
 * An unknown value means `full`, with one warning line.
 */
export function toolProfile(
  value: string | undefined = process.env.SFGRAPH_TOOLS,
  warn: (line: string) => void = (line) => process.stderr.write(`${line}\n`),
): ToolProfile {
  const v = (value ?? "").trim().toLowerCase();
  if (v === "core") return "core";
  if (v !== "" && v !== "full")
    warn(
      `sfgraph: unknown SFGRAPH_TOOLS value "${value}"; serving the full tool list (use core or full).`,
    );
  return "full";
}

export const inProfile = (name: string, profile: ToolProfile): boolean =>
  profile === "full" || CORE_TOOLS.includes(name);

/** The tools/list entries for `profile`, exactly as the server sends them. */
export function toolList(
  registry: ToolRegistry,
  profile: ToolProfile,
): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> {
  return registry
    .list()
    .filter((t) => inProfile(t.name, profile))
    .map((t) => ({
      name: t.name,
      description: t.schema.description,
      inputSchema: t.schema.inputSchema ?? { type: "object" },
    }));
}
