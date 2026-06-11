import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { makeTestCtx } from "../../__tests__/_harness.js";
import { FlowParser } from "../index.js";

const FIX = path.resolve(__dirname, "../../__tests__/fixtures/flow");

/**
 * Flows previously stored NO source — explain_code / find_similar could not
 * open them. The parser now emits the Flow XML as a "flow" snippet keyed by the
 * Flow qname so those tools can read and reason about the Flow's logic.
 */
describe("FlowParser — definition snippet", () => {
  it("stores the Flow XML as a snippet under the Flow qname", async () => {
    const xml = readFileSync(path.join(FIX, "Account_Update_Status.flow-meta.xml"), "utf8");
    const result = await new FlowParser().parse(
      { fullName: "Account_Update_Status", xml },
      makeTestCtx(),
    );
    expect(result.snippets).toHaveLength(1);
    const s = result.snippets?.[0];
    expect(String(s?.qualifiedName)).toBe("Flow:Account_Update_Status");
    expect(s?.sourceFormat).toBe("flow");
    expect(s?.sourceText).toContain("<Flow");
  });

  it("emits no snippet for an empty Flow body", async () => {
    const result = await new FlowParser().parse({ fullName: "Empty", xml: "" }, makeTestCtx());
    expect(result.snippets ?? []).toHaveLength(0);
  });
});
