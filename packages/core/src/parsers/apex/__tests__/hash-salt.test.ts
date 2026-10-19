import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { makeTestCtx } from "../../__tests__/_harness.js";
import { ApexClassParser } from "../class.js";

const raw = (s: string) => createHash("sha256").update(s).digest("hex");

/**
 * Audit fix round 1 (I-2): node merge keeps stored attributes while
 * `sourceHash` is unchanged, so Apex node hashes must not be content-only, or
 * a re-ingest after the header/arity fixes would keep pre-fix attributes.
 */
describe("Apex node hash salt", () => {
  it("salts the class node hash (a pre-salt hash no longer matches)", async () => {
    const body = "public class Foo { public void bar(Integer a) { } }";
    const r = await new ApexClassParser().parse({ className: "Foo", body }, makeTestCtx());
    const cls = r.nodes.find((n) => n.label === "ApexClass");
    expect(cls).toBeDefined();
    expect(String(cls?.sourceHash)).not.toBe(raw(body));
  });
});
