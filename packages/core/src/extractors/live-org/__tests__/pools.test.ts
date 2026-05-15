import Bottleneck from "bottleneck";
import { afterEach, describe, expect, it } from "vitest";
import {
  configureDefaultPools,
  createRateLimitPools,
  dataPool,
  DEFAULT_POOL_CONCURRENCY,
  metadataPool,
  scheduleData,
  scheduleMetadata,
  toolingPool,
} from "../rate-limit.js";

describe("rate-limit pools", () => {
  it("exposes three independent Bottleneck instances with documented concurrency budgets", () => {
    expect(toolingPool).toBeInstanceOf(Bottleneck);
    expect(metadataPool).toBeInstanceOf(Bottleneck);
    expect(dataPool).toBeInstanceOf(Bottleneck);
    // Distinct instances — splitting head-of-line blocking is the whole point.
    expect(toolingPool).not.toBe(metadataPool);
    expect(metadataPool).not.toBe(dataPool);
    expect(toolingPool).not.toBe(dataPool);
    // Documented maxConcurrent settings.
    // @ts-expect-error -- Bottleneck stores options on _store.storeOptions
    const toolingOpts = toolingPool._store.storeOptions;
    // @ts-expect-error
    const metaOpts = metadataPool._store.storeOptions;
    // @ts-expect-error
    const dataOpts = dataPool._store.storeOptions;
    expect(toolingOpts.maxConcurrent).toBe(5);
    expect(metaOpts.maxConcurrent).toBe(10);
    expect(dataOpts.maxConcurrent).toBe(10);
  });

  it("scheduleMetadata and scheduleData pass values through", async () => {
    expect(await scheduleMetadata(async () => "m")).toBe("m");
    expect(await scheduleData(async () => 42)).toBe(42);
  });
});

describe("rate-limit pool overrides", () => {
  // Capture defaults so we can restore between tests.
  const restore = async () => {
    delete process.env.SFGRAPH_TOOLING_POOL;
    delete process.env.SFGRAPH_METADATA_POOL;
    delete process.env.SFGRAPH_DATA_POOL;
    await configureDefaultPools({
      tooling: DEFAULT_POOL_CONCURRENCY.tooling,
      metadata: DEFAULT_POOL_CONCURRENCY.metadata,
      data: DEFAULT_POOL_CONCURRENCY.data,
    });
  };
  afterEach(restore);

  it("createRateLimitPools accepts explicit overrides", () => {
    const pools = createRateLimitPools({ tooling: 2, metadata: 8, data: 12 });
    // @ts-expect-error -- _store.storeOptions is private
    expect(pools.toolingPool._store.storeOptions.maxConcurrent).toBe(2);
    // @ts-expect-error
    expect(pools.metadataPool._store.storeOptions.maxConcurrent).toBe(8);
    // @ts-expect-error
    expect(pools.dataPool._store.storeOptions.maxConcurrent).toBe(12);
  });

  it("createRateLimitPools honours SFGRAPH_*_POOL env when no override given", () => {
    process.env.SFGRAPH_METADATA_POOL = "9";
    const pools = createRateLimitPools();
    // @ts-expect-error
    expect(pools.metadataPool._store.storeOptions.maxConcurrent).toBe(9);
  });

  it("createRateLimitPools rejects invalid env values (non-positive, non-numeric)", () => {
    process.env.SFGRAPH_METADATA_POOL = "-3";
    const pools = createRateLimitPools();
    // @ts-expect-error
    expect(pools.metadataPool._store.storeOptions.maxConcurrent).toBe(
      DEFAULT_POOL_CONCURRENCY.metadata,
    );
  });

  it("configureDefaultPools mutates module-level singletons live", async () => {
    const applied = await configureDefaultPools({ metadata: 7 });
    expect(applied.metadata).toBe(7);
    // @ts-expect-error
    expect(metadataPool._store.storeOptions.maxConcurrent).toBe(7);
    // Unspecified pools fall back to defaults (env is unset here).
    // @ts-expect-error
    expect(toolingPool._store.storeOptions.maxConcurrent).toBe(DEFAULT_POOL_CONCURRENCY.tooling);
    // @ts-expect-error
    expect(dataPool._store.storeOptions.maxConcurrent).toBe(DEFAULT_POOL_CONCURRENCY.data);
  });
});
