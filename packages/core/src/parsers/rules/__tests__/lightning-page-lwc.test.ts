import { beforeAll, describe, expect, it } from "vitest";
import { makeTestCtx } from "../../__tests__/_harness.js";
import { parserRegistry } from "../../registry.js";
import { loadAllRules } from "../_loader.js";

const page = (names: string[]) =>
  `<?xml version="1.0"?><FlexiPage><type>RecordPage</type><flexiPageRegions>${names
    .map(
      (n) =>
        `<itemInstances><componentInstance><componentName>${n}</componentName></componentInstance></itemInstances>`,
    )
    .join("")}</flexiPageRegions></FlexiPage>`;

describe("FlexiPage EMBEDS_LWC", () => {
  beforeAll(async () => {
    await loadAllRules();
  });

  it("targets LWC:<name> for c:-prefixed and bare names, skipping other namespaces", async () => {
    const p = parserRegistry.for("FlexiPage");
    if (!p) throw new Error("no FlexiPage parser");
    const r = await p.parse(
      {
        name: "Sample_Page",
        xml: page([
          "c:widgetPanel",
          "bareWidget",
          "flexipage:tab",
          "force:detailPanel",
          "ns:thing",
        ]),
      },
      makeTestCtx(),
    );
    const dsts = r.edges
      .filter((e) => e.relType === "EMBEDS_LWC")
      .map((e) => String(e.dstQualifiedName))
      .sort();
    expect(dsts).toEqual(["LWC:bareWidget", "LWC:widgetPanel"]);
  });
});
