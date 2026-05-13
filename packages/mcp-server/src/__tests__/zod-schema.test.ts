import { describe, expect, it } from "vitest";
import { defaultRegistry } from "../tool-registry.js";
import "../tools/index.js";

describe("registered tool schemas", () => {
  it("each tool has a valid JSON Schema-shape inputSchema", () => {
    const tools = defaultRegistry.list();
    expect(tools.length).toBeGreaterThanOrEqual(19);
    for (const t of tools) {
      expect(t.schema.inputSchema, `tool ${t.name} missing inputSchema`).toBeDefined();
      const s = t.schema.inputSchema as Record<string, unknown>;
      expect(typeof s.type === "string", `tool ${t.name} schema missing type`).toBe(true);
    }
  });
});
