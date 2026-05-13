import type { RegisteredTool } from "../tool-registry.js";

export const pingTool: RegisteredTool = {
  name: "ping",
  schema: {
    description: "health check",
    inputSchema: { type: "object", properties: {} },
  },
  handler: async () => ({ ok: true, ts: Date.now() }),
};
