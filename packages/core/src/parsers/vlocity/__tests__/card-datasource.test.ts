import { describe, expect, it } from "vitest";
import { REL_TYPES } from "../../../domain/index.js";
import { makeTestCtx } from "../../__tests__/_harness.js";
import { classifyDataSource } from "../common.js";
import { VlocityCardParser } from "../vlocity-card.js";

describe("classifyDataSource", () => {
  it("DataRaptor type -> dataraptor ref on value.bundle", () => {
    expect(classifyDataSource({ type: "DataRaptor", value: { bundle: "GetThing" } })).toEqual([
      { kind: "dataraptor", target: "GetThing", attrs: { via: "dataSource" } },
    ]);
  });
  it("Integration Procedure type -> ip ref on value.ipMethod", () => {
    expect(
      classifyDataSource({ type: "IntegrationProcedures", value: { ipMethod: "Proc_Key" } }),
    ).toEqual([{ kind: "ip", target: "Proc_Key", attrs: { via: "dataSource" } }]);
  });
  it("remoteClass (any type) -> remote ref with method", () => {
    expect(
      classifyDataSource({ type: "Dual", value: { remoteClass: "Svc", remoteMethod: "go" } }),
    ).toEqual([
      {
        kind: "remote",
        target: "Svc",
        attrs: { remoteClass: "Svc", remoteMethod: "go", via: "dataSource" },
      },
    ]);
  });
  it("empty values and non-objects produce nothing", () => {
    expect(classifyDataSource({ type: "DataRaptor", value: { bundle: " " } })).toEqual([]);
    expect(classifyDataSource("x")).toEqual([]);
    expect(classifyDataSource({ type: "Custom", value: { body: "{}" } })).toEqual([]);
  });
});

describe("VlocityCardParser dataSource", () => {
  it("emits edges for nested and per-state dataSources", async () => {
    const datapack = {
      Name: "c1",
      Definition: {
        dataSource: { type: "DataRaptor", value: { bundle: "DR_A" } },
        states: [
          { dataSource: { type: "IntegrationProcedures", value: { ipMethod: "IP_B" } } },
          {
            fields: [],
            dataSource: { type: "ApexRemote", value: { remoteClass: "Svc", remoteMethod: "m" } },
          },
        ],
      },
    };
    const r = await new VlocityCardParser().parse({ name: "c1", datapack }, makeTestCtx());
    const got = r.edges.map((e) => `${e.relType} ${e.dstQualifiedName}`).sort();
    expect(got).toEqual(
      [
        `${REL_TYPES.VC_USES_DR} DataRaptor:DR_A`,
        `${REL_TYPES.VC_CALLS_IP} IntegrationProcedure:IP_B`,
        `${REL_TYPES.VC_INVOKES_REMOTE} Remote:Svc`,
      ].sort(),
    );
    const remote = r.edges.find((e) => e.relType === REL_TYPES.VC_INVOKES_REMOTE);
    expect(remote?.attributes).toMatchObject({ remoteClass: "Svc", remoteMethod: "m" });
  });
  it("handles the top-level Datasource field as object or JSON string", async () => {
    const mk = (Datasource: unknown) =>
      new VlocityCardParser().parse(
        { name: "c2", datapack: { Name: "c2", Datasource } },
        makeTestCtx(),
      );
    const obj = await mk({ type: "DataRaptor", value: { bundle: "DR_X" } });
    const str = await mk(JSON.stringify({ type: "DataRaptor", value: { bundle: "DR_X" } }));
    for (const r of [obj, str])
      expect(r.edges.map((e) => String(e.dstQualifiedName))).toEqual(["DataRaptor:DR_X"]);
  });
});
