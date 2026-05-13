import { describe, expect, it } from "vitest";
import type { OrgCapabilities } from "../capabilities.js";
import type { DescribedType } from "../discovery.js";
import { buildDispatchTable, routeFor } from "../dispatch.js";

const baseCaps: OrgCapabilities = {
  detectedNamespaces: [],
  vlocityNamespaces: [],
  vlocityLegacy: false,
  vlocityCmt: false,
  omnistudioOncore: false,
  agentforce: false,
  experienceCloud: false,
  sourceTracking: false,
};

function t(xmlName: string): DescribedType {
  return { xmlName, childXmlNames: [], inFolder: false, metaFile: false };
}

describe("routeFor", () => {
  it("routes ApexClass to toolingSoql", () => {
    expect(routeFor(t("ApexClass"), baseCaps)).toEqual({
      strategy: "toolingSoql",
      type: "ApexClass",
    });
  });

  it("routes Profile to metadataReadList", () => {
    expect(routeFor(t("Profile"), baseCaps)).toEqual({
      strategy: "metadataReadList",
      type: "Profile",
    });
  });

  it("routes DataRaptor to vlocityRunner when vlocityLegacy is true", () => {
    const caps: OrgCapabilities = {
      ...baseCaps,
      vlocityLegacy: true,
      vlocityNamespaces: ["vlocity_cmt"],
    };
    expect(routeFor(t("DataRaptor"), caps)).toEqual({
      strategy: "vlocityRunner",
      type: "DataRaptor",
    });
  });

  it("falls back to metadataReadList for DataRaptor when vlocityLegacy is false", () => {
    expect(routeFor(t("DataRaptor"), baseCaps)).toEqual({
      strategy: "metadataReadList",
      type: "DataRaptor",
    });
  });
});

describe("buildDispatchTable", () => {
  it("adds Vlocity DataPack types even when not described, when vlocityLegacy is true", () => {
    const caps: OrgCapabilities = {
      ...baseCaps,
      vlocityLegacy: true,
      vlocityNamespaces: ["vlocity_cmt"],
    };
    const table = buildDispatchTable([t("ApexClass")], caps);
    expect(table.get("DataRaptor")).toEqual({
      strategy: "vlocityRunner",
      type: "DataRaptor",
    });
    expect(table.get("OmniScript")?.strategy).toBe("vlocityRunner");
    expect(table.get("ApexClass")?.strategy).toBe("toolingSoql");
  });

  it("does not inject Vlocity types when vlocityLegacy is false", () => {
    const table = buildDispatchTable([t("Flow")], baseCaps);
    expect(table.has("DataRaptor")).toBe(false);
    expect(table.get("Flow")?.strategy).toBe("metadataReadList");
  });
});
