import { StorageError } from "@sfgraph/shared";
import { describe, expect, it } from "vitest";
import { validateLabel, validateRelType } from "../identifier.js";

describe("validateLabel", () => {
  it("accepts simple alphanumeric labels", () => {
    expect(validateLabel("ApexClass")).toBe("ApexClass");
    expect(validateLabel("a")).toBe("a");
    expect(validateLabel("Some_Label_123")).toBe("Some_Label_123");
  });

  it("rejects SQL injection attempt with semicolon and space", () => {
    expect(() => validateLabel("drop table x;")).toThrow(StorageError);
  });

  it("rejects label containing space", () => {
    expect(() => validateLabel("foo bar")).toThrow(StorageError);
  });

  it("rejects label containing quote", () => {
    expect(() => validateLabel('"x"')).toThrow(StorageError);
  });

  it("rejects empty string", () => {
    expect(() => validateLabel("")).toThrow(StorageError);
  });

  it("rejects label starting with a digit", () => {
    expect(() => validateLabel("1abc")).toThrow(StorageError);
  });
});

describe("validateRelType", () => {
  it("accepts standard rel types", () => {
    expect(validateRelType("READS_FIELD")).toBe("READS_FIELD");
    expect(validateRelType("CALLS")).toBe("CALLS");
  });

  it("rejects rel type with dash", () => {
    expect(() => validateRelType("READS-FIELD")).toThrow(StorageError);
  });
});
