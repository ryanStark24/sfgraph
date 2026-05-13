import { StorageError } from "@ryanstark24/sfgraph-shared";
import { describe, expect, it } from "vitest";
import "../index.js"; // trigger registration
import { METADATA_CATEGORY } from "../../domain/index.js";
import type { ParseResult, Parser } from "../contract.js";
import { parserRegistry } from "../registry.js";

class FakeParser implements Parser<unknown> {
  readonly category = METADATA_CATEGORY.APEX_CLASS;
  readonly type = "FakeUniqueType_42";
  async parse(): Promise<ParseResult> {
    return { nodes: [], edges: [] };
  }
}

describe("ParserRegistry", () => {
  it("looks up registered parsers by type", () => {
    expect(parserRegistry.for("ApexClass")).toBeDefined();
    expect(parserRegistry.for("LightningComponentBundle")).toBeDefined();
  });

  it("rejects duplicate registration with a StorageError", () => {
    parserRegistry.register(new FakeParser());
    expect(() => parserRegistry.register(new FakeParser())).toThrow(StorageError);
  });
});
