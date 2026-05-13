import { defaultRegistry } from "../../tool-registry.js";

// Side-effect load all tools.
import "../index.js";

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
  return r;
}

export { defaultRegistry };
