import { defaultRegistry } from "../../tool-registry.js";

// Side-effect load all tools.
import "../index.js";

/**
 * T5 review fix 2: an MCP client receives only the result text (server.ts runTool), never `data`,
 * so a result text must not point the caller at a `data.*` field. Every tool test that goes
 * through callTool checks its fixture output against this.
 */
export const DATA_POINTER = /`data\.|\bdata\.[a-z][A-Za-z]*/;

export function assertNoDataPointer(name: string, r: { summary?: unknown; markdown?: unknown }) {
  for (const part of [r.summary, r.markdown]) {
    if (typeof part !== "string") continue;
    const m = DATA_POINTER.exec(part);
    if (m)
      throw new Error(
        `${name} result text points at ${m[0]}: ${part.slice(Math.max(0, m.index - 80), m.index + 40)}`,
      );
  }
}

export async function callTool(
  name: string,
  args: Record<string, unknown>,
): Promise<{
  summary: string;
  markdown: string;
  data: unknown;
  follow_up_tools?: string[];
}> {
  const tool = defaultRegistry.get(name);
  if (!tool) throw new Error(`tool not registered: ${name}`);
  const r = (await tool.handler(args)) as unknown as {
    summary: string;
    markdown: string;
    data: unknown;
    follow_up_tools?: string[];
  };
  assertNoDataPointer(name, r);
  return r;
}

export { defaultRegistry };
