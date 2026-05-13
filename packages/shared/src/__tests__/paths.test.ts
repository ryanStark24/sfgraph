import { describe, expect, it } from "vitest";
import { getSfgraphPaths } from "../paths.js";

describe("paths", () => {
  it("returns plausible directories", () => {
    const p = getSfgraphPaths();
    expect(p.data).toMatch(/sfgraph/);
    expect(p.cache).toMatch(/sfgraph/);
    expect(p.log).toMatch(/sfgraph/);
    expect(p.config).toMatch(/sfgraph/);
    expect(typeof p.temp).toBe("string");
  });
});
