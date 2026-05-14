import { afterEach, describe, expect, it } from "vitest";
import { getSfgraphPaths } from "../paths.js";

describe("paths", () => {
  const saved = {
    data: process.env.SFGRAPH_DATA_DIR,
    config: process.env.SFGRAPH_CONFIG_DIR,
    cache: process.env.SFGRAPH_CACHE_DIR,
    log: process.env.SFGRAPH_LOG_DIR,
    temp: process.env.SFGRAPH_TEMP_DIR,
  };
  afterEach(() => {
    // biome-ignore lint/performance/noDelete: cleanup test-scoped env
    if (saved.data === undefined) delete process.env.SFGRAPH_DATA_DIR;
    else process.env.SFGRAPH_DATA_DIR = saved.data;
    // biome-ignore lint/performance/noDelete: cleanup test-scoped env
    if (saved.config === undefined) delete process.env.SFGRAPH_CONFIG_DIR;
    else process.env.SFGRAPH_CONFIG_DIR = saved.config;
    // biome-ignore lint/performance/noDelete: cleanup test-scoped env
    if (saved.cache === undefined) delete process.env.SFGRAPH_CACHE_DIR;
    else process.env.SFGRAPH_CACHE_DIR = saved.cache;
    // biome-ignore lint/performance/noDelete: cleanup test-scoped env
    if (saved.log === undefined) delete process.env.SFGRAPH_LOG_DIR;
    else process.env.SFGRAPH_LOG_DIR = saved.log;
  });

  it("returns plausible directories", () => {
    const p = getSfgraphPaths();
    expect(p.data).toMatch(/sfgraph/);
    expect(p.cache).toMatch(/sfgraph/);
    expect(p.log).toMatch(/sfgraph/);
    expect(p.config).toMatch(/sfgraph/);
    expect(typeof p.temp).toBe("string");
  });

  it("honors SFGRAPH_DATA_DIR / _CONFIG_DIR / _CACHE_DIR / _LOG_DIR env vars", () => {
    process.env.SFGRAPH_DATA_DIR = "/tmp/x-data";
    process.env.SFGRAPH_CONFIG_DIR = "/tmp/x-config";
    process.env.SFGRAPH_CACHE_DIR = "/tmp/x-cache";
    process.env.SFGRAPH_LOG_DIR = "/tmp/x-log";
    const p = getSfgraphPaths();
    expect(p.data).toBe("/tmp/x-data");
    expect(p.config).toBe("/tmp/x-config");
    expect(p.cache).toBe("/tmp/x-cache");
    expect(p.log).toBe("/tmp/x-log");
  });
});
