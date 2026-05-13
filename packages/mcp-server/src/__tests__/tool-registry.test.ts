import { describe, expect, it } from "vitest";
import { ToolRegistry } from "../tool-registry.js";
import { pingTool } from "../tools/ping.js";

describe("ToolRegistry", () => {
  it("registers and lists tools", () => {
    const r = new ToolRegistry();
    r.register(pingTool.name, pingTool.handler, pingTool.schema);
    expect(r.list().map((t) => t.name)).toEqual(["ping"]);
  });

  it("throws on duplicate register", () => {
    const r = new ToolRegistry();
    r.register("x", async () => ({}), { description: "x" });
    expect(() => r.register("x", async () => ({}), { description: "x" })).toThrow();
  });

  it("ping returns ok+ts", async () => {
    const r = await pingTool.handler({});
    expect(r["ok"]).toBe(true);
    expect(typeof r["ts"]).toBe("number");
  });
});
