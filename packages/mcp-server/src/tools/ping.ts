import type { RegisteredTool } from "../tool-registry.js";
import { defineTool, z } from "./_define.js";
import { withInShort } from "./_report.js";

defineTool({
  name: "ping",
  description: "Health check.",
  inputSchema: z.object({}).strict(),
  async execute() {
    return {
      summary: "ok",
      markdown: withInShort("The sfgraph server is running and answering.", "pong"),
      data: { ok: true, ts: Date.now() },
    };
  },
});

// Back-compat export for Phase 0 tests that import pingTool directly.
export const pingTool: RegisteredTool = {
  name: "ping",
  schema: {
    description: "health check",
    inputSchema: { type: "object", properties: {} },
  },
  handler: async () => ({ ok: true, ts: Date.now() }),
};
