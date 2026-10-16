import { describe, expect, it } from "vitest";
import { makeTestCtx } from "../../__tests__/_harness.js";
import { OmniProcessParser } from "../../omnistudio/process.js";
import { OmniScriptParser } from "../omni-script.js";

/**
 * Audit corecorr-13: asJson swallows JSON.parse errors as {}, so a truncated
 * DataPack string yields an edgeless OmniScript node with no ParseError.
 */
describe("audit corecorr-13: malformed DataPack JSON is reported", () => {
  it("surfaces a ParseError (or rejects) for a truncated datapack string", async () => {
    const truncated = '{"elements":[{"Type":"Remote Action","propertySet":{"remoteClass":"Svc"';
    let result: Awaited<ReturnType<OmniScriptParser["parse"]>>;
    try {
      result = await new OmniScriptParser().parse(
        { name: "T_S_English", datapack: truncated } as never,
        makeTestCtx(),
      );
    } catch {
      return; // throwing a parse error is an acceptable fix
    }
    expect(result.nodes.some((n) => n.label === "ParseError")).toBe(true);
  });

  it("reports a truncated native OmniProcess payload, but not a well-formed one", async () => {
    const parser = new OmniProcessParser();
    const bad = await parser.parse(
      { name: "T_S_English", metadata: '{"elements":[' },
      makeTestCtx(),
    );
    const err = bad.nodes.find((n) => n.label === "ParseError");
    expect(err?.attributes.message).toMatch(/malformed JSON payload/);
    expect(bad.nodes.some((n) => n.label === "OmniProcess")).toBe(true);
    const ok = await parser.parse(
      { name: "T_S_English", metadata: '{"elements":[]}' },
      makeTestCtx(),
    );
    expect(ok.nodes.some((n) => n.label === "ParseError")).toBe(false);
  });
});
