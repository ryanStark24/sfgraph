import path from "node:path";
import { describe, expect, it } from "vitest";
import { ErrorCode, SfgraphError } from "../errors.js";
import { safeOrgDbPath, validateOrgIdentifier } from "../org-identifier.js";

function expectReject(value: unknown): void {
  try {
    validateOrgIdentifier(value);
    throw new Error(`expected reject for ${JSON.stringify(value)}`);
  } catch (e) {
    expect(e).toBeInstanceOf(SfgraphError);
    expect((e as SfgraphError).code).toBe(ErrorCode.E_INVALID_ORG_IDENTIFIER);
  }
}

describe("validateOrgIdentifier", () => {
  it("accepts a valid 18-char Salesforce ID", () => {
    expect(validateOrgIdentifier("00D1x000000abcdEAA")).toBe("00D1x000000abcdEAA");
  });
  it("accepts a valid 15-char Salesforce ID", () => {
    expect(validateOrgIdentifier("00D1x000000abcd")).toBe("00D1x000000abcd");
  });
  it("accepts a valid alias", () => {
    expect(validateOrgIdentifier("my-sandbox")).toBe("my-sandbox");
    expect(validateOrgIdentifier("prod_us-east_2")).toBe("prod_us-east_2");
  });
  it("rejects parent-dir traversal", () => {
    expectReject("../foo");
    expectReject("..");
    expectReject("a..b");
  });
  it("rejects absolute / path separators", () => {
    expectReject("/abs/path");
    expectReject("foo/bar");
    expectReject("foo\\bar");
  });
  it("rejects NUL and control chars", () => {
    expectReject("foo\x00");
    expectReject("foo\x01");
  });
  it("rejects Windows-reserved names", () => {
    expectReject("con");
    expectReject("COM1");
    expectReject("nul");
  });
  it("rejects empty / very-long / leading dot", () => {
    expectReject("");
    expectReject("a".repeat(65));
    expectReject(".hidden");
  });
  it("rejects non-strings", () => {
    expectReject(null);
    expectReject(undefined);
    expectReject(123);
  });
});

describe("safeOrgDbPath", () => {
  it("builds a path inside dataDir for a valid alias", () => {
    const p = safeOrgDbPath("/tmp/data", "my-org");
    expect(p).toBe(path.resolve("/tmp/data", "my-org.sqlite"));
  });
  it("rejects identifiers that try to escape the data dir", () => {
    expect(() => safeOrgDbPath("/tmp/data", "../escape")).toThrow(SfgraphError);
  });
});
