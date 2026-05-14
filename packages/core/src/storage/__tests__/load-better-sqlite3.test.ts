import { ErrorCode, SfgraphError } from "@ryanstark24/sfgraph-shared";
import { describe, expect, it } from "vitest";
import { isAbiMismatch, loadBetterSqlite3, wrapAbiError } from "../sqlite/load-better-sqlite3.js";

describe("isAbiMismatch", () => {
  it("matches NODE_MODULE_VERSION runtime errors", () => {
    expect(
      isAbiMismatch(
        "The module was compiled against a different Node.js version using NODE_MODULE_VERSION 141. This version of Node.js requires NODE_MODULE_VERSION 137.",
      ),
    ).toBe(true);
  });

  it("matches 'Module did not self-register' phrasing", () => {
    expect(isAbiMismatch("Module did not self-register: /path/to/better_sqlite3.node")).toBe(true);
  });

  it("does not match unrelated errors", () => {
    expect(isAbiMismatch("Cannot find module 'better-sqlite3'")).toBe(false);
    expect(isAbiMismatch("ENOENT: no such file or directory")).toBe(false);
  });
});

describe("wrapAbiError", () => {
  it("converts ABI mismatch errors to E_NATIVE_ABI_MISMATCH SfgraphError", () => {
    const original = new Error("NODE_MODULE_VERSION mismatch detected");
    const wrapped = wrapAbiError(original);
    expect(wrapped).toBeInstanceOf(SfgraphError);
    expect(wrapped?.code).toBe(ErrorCode.E_NATIVE_ABI_MISMATCH);
    expect(wrapped?.message).toContain("ABI mismatch");
    expect(wrapped?.message).toContain(process.version);
    expect(wrapped?.message).toContain(process.versions.modules);
    expect(wrapped?.message).toMatch(/rebuild better-sqlite3/);
    expect(wrapped?.cause).toBe(original);
  });

  it("returns null for non-ABI errors", () => {
    expect(wrapAbiError(new Error("permission denied"))).toBeNull();
    expect(wrapAbiError("not an error")).toBeNull();
  });
});

describe("loadBetterSqlite3", () => {
  it("throws E_NATIVE_ABI_MISMATCH SfgraphError when require fails with ABI mismatch", () => {
    const fakeRequire = (id: string) => {
      if (id === "better-sqlite3") {
        throw new Error(
          "The module 'X' was compiled against a different Node.js version using NODE_MODULE_VERSION 141",
        );
      }
      throw new Error("unexpected id");
    };
    expect(() => loadBetterSqlite3(fakeRequire)).toThrow(SfgraphError);
    try {
      loadBetterSqlite3(fakeRequire);
    } catch (e) {
      expect(e).toBeInstanceOf(SfgraphError);
      expect((e as SfgraphError).code).toBe(ErrorCode.E_NATIVE_ABI_MISMATCH);
      // Recovery message must include actionable pieces
      expect((e as SfgraphError).message).toMatch(/Node:/);
      expect((e as SfgraphError).message).toMatch(/Recovery:/);
    }
  });

  it("rethrows non-ABI errors unchanged", () => {
    const fakeRequire = () => {
      throw new Error("ENOENT no such file");
    };
    expect(() => loadBetterSqlite3(fakeRequire)).toThrow(/ENOENT/);
  });

  it("returns the module when require succeeds", () => {
    const fakeMod = { sentinel: true };
    const fakeRequire = () => fakeMod;
    expect(loadBetterSqlite3(fakeRequire)).toBe(fakeMod);
  });
});
