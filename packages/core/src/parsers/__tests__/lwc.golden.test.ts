import path from "node:path";
import { describe, it } from "vitest";
import { LwcBundleParser } from "../lwc/index.js";
import { readBundle, runGolden } from "./_harness.js";

const FIX = path.resolve(__dirname, "fixtures/lwc");

describe("lwc golden", () => {
  it("parses accountTile bundle", async () => {
    const files = readBundle(path.join(FIX, "accountTile"));
    await runGolden(
      new LwcBundleParser(),
      { bundleName: "accountTile", files },
      path.join(FIX, "accountTile.expected.json"),
    );
  });

  it("parses simpleHello bundle", async () => {
    const files = readBundle(path.join(FIX, "simpleHello"));
    await runGolden(
      new LwcBundleParser(),
      { bundleName: "simpleHello", files },
      path.join(FIX, "simpleHello.expected.json"),
    );
  });
});
