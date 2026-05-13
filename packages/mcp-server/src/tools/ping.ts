import type { RegisteredTool } from "../tool-registry.js";
import { defineTool, z } from "./_define.js";

defineTool({
  name: "ping",
  description: "health check — returns ok+ts",
  inputSchema: z.object({}).strict(),
  async execute() {
    return {
      summary: "ok",
      markdown: "pong",
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
