import { describe, expect, it } from "vitest";
import { discoverMetadataTypes } from "../discovery.js";

function connWith(metadataObjects: any): any {
  return {
    metadata: {
      describe: async () => ({ metadataObjects }),
    },
  };
}

describe("discoverMetadataTypes", () => {
  it("returns parsed DescribedType[] with xmlName/suffix/directoryName", async () => {
    const conn = connWith([
      {
        xmlName: "ApexClass",
        suffix: "cls",
        directoryName: "classes",
        childXmlNames: [],
        inFolder: false,
        metaFile: true,
      },
      {
        xmlName: "Profile",
        suffix: "profile",
        directoryName: "profiles",
        childXmlNames: ["ProfileFieldLevelSecurity"],
        inFolder: false,
        metaFile: false,
      },
    ]);
    const types = await discoverMetadataTypes(conn, "60.0");
    expect(types).toHaveLength(2);
    expect(types[0]).toMatchObject({
      xmlName: "ApexClass",
      suffix: "cls",
      directoryName: "classes",
      metaFile: true,
    });
    expect(types[1]?.childXmlNames).toEqual(["ProfileFieldLevelSecurity"]);
  });

  it("returns an empty array when metadataObjects is empty", async () => {
    const conn = connWith([]);
    const types = await discoverMetadataTypes(conn);
    expect(types).toEqual([]);
  });

  it("skips entries with empty xmlName", async () => {
    const conn = connWith([
      { xmlName: "", suffix: "cls" },
      { xmlName: "Flow", suffix: "flow" },
      { suffix: "x" },
    ]);
    const types = await discoverMetadataTypes(conn);
    expect(types.map((t) => t.xmlName)).toEqual(["Flow"]);
  });
});
