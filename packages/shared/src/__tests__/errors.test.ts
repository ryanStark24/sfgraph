import { describe, expect, it } from "vitest";
import {
  ConfigError,
  ErrorCode,
  MigrationError,
  ReadOnlyViolationError,
  SfgraphError,
  StorageError,
  TelemetryError,
  ValidationError,
} from "../errors.js";

describe("errors", () => {
  it("SfgraphError carries a code", () => {
    const e = new SfgraphError(ErrorCode.CONFIG, "oops");
    expect(e.code).toBe("CONFIG");
    expect(e.message).toBe("oops");
    expect(e instanceof Error).toBe(true);
  });

  it.each([
    [ReadOnlyViolationError, ErrorCode.READ_ONLY_VIOLATION],
    [ConfigError, ErrorCode.CONFIG],
    [StorageError, ErrorCode.STORAGE],
    [MigrationError, ErrorCode.MIGRATION],
    [TelemetryError, ErrorCode.TELEMETRY],
    [ValidationError, ErrorCode.VALIDATION],
  ])("%s sets stable code", (Ctor, code) => {
    const e = new (Ctor as any)("m");
    expect(e.code).toBe(code);
    expect(e instanceof SfgraphError).toBe(true);
  });
});
