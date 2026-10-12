import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { adaptParserInput } from "../../../ingest/live-ingest.js";
import { makeTestCtx } from "../../__tests__/_harness.js";
import { APEX_NODE_HASH_SALT, ApexClassParser } from "../class.js";

/** Live extractor records a local class's managed same-name collision in the
 *  metaXml envelope; the parser must surface it as `shadowsManaged` and fold
 *  it into the node hash so an already-stored node picks the attr up. */
const META = (extra: string) =>
  `<?xml version="1.0" encoding="UTF-8"?>\n<ApexClass>\n  <apiVersion>60</apiVersion>\n${extra}</ApexClass>`;

async function classNode(body: string, metaXml?: string) {
  const r = await new ApexClassParser().parse(
    { className: "TestDataFactory", body, ...(metaXml ? { metaXml } : {}) },
    makeTestCtx(),
  );
  return r.nodes.find((n) => n.label === "ApexClass");
}

describe("ApexClassParser — shadowsManaged", () => {
  const BODY = "public class TestDataFactory { public static void a() {} }";

  it("sets the attr from the metaXml envelope and changes the hash", async () => {
    const plain = await classNode(BODY, META(""));
    const shadow = await classNode(BODY, META("  <shadowsManaged>trailheadapp</shadowsManaged>\n"));
    expect((shadow?.attributes as Record<string, unknown>).shadowsManaged).toEqual([
      "trailheadapp",
    ]);
    expect((plain?.attributes as Record<string, unknown>).shadowsManaged).toBeUndefined();
    expect(shadow?.sourceHash).not.toBe(plain?.sourceHash);
  });

  it("leaves the hash of non-colliding classes unchanged", async () => {
    expect((await classNode(BODY, META("")))?.sourceHash).toBe((await classNode(BODY))?.sourceHash);
  });

  it("pins the non-colliding hash to the pre-shadowsManaged formula", async () => {
    // Comparing two runs of the new code would also pass if the suffix were
    // always appended (review M8); pin it to sha256(SALT + "\n" + body).
    const expected = createHash("sha256").update(`${APEX_NODE_HASH_SALT}\n${BODY}`).digest("hex");
    expect((await classNode(BODY, META("")))?.sourceHash).toBe(expected);
    expect((await classNode(BODY))?.sourceHash).toBe(expected);
  });

  it("reaches the parser through the live content envelope", async () => {
    const content = JSON.stringify({
      body: BODY,
      metaXml: META("  <shadowsManaged>a</shadowsManaged>\n  <shadowsManaged>b</shadowsManaged>\n"),
    });
    const adapted = adaptParserInput(
      {
        category: "apex-class",
        memberType: "ApexClass",
        memberName: "TestDataFactory",
        lastModifiedAt: null,
        sourceUri: "sf://tooling/ApexClass/TestDataFactory",
        namespace: null,
      } as never,
      content,
    );
    const r = await new ApexClassParser().parse(adapted?.input as never, makeTestCtx());
    const n = r.nodes.find((x) => x.label === "ApexClass");
    expect((n?.attributes as Record<string, unknown>).shadowsManaged).toEqual(["a", "b"]);
  });
});
