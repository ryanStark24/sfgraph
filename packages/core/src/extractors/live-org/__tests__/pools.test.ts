import Bottleneck from "bottleneck";
import { describe, expect, it } from "vitest";
import {
  dataPool,
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
    expect(metaOpts.maxConcurrent).toBe(3);
    expect(dataOpts.maxConcurrent).toBe(10);
  });

  it("scheduleMetadata and scheduleData pass values through", async () => {
    expect(await scheduleMetadata(async () => "m")).toBe("m");
    expect(await scheduleData(async () => 42)).toBe(42);
  });
});
