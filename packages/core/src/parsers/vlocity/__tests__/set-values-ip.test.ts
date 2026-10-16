import { asOrgId, asQualifiedName, asSha256 } from "@ryanstark24/sfgraph-shared";
import { describe, expect, it } from "vitest";
import { REL_TYPES } from "../../../domain/index.js";
import { SqliteGraphStore } from "../../../storage/sqlite/graph-store.js";
import { makeTestCtx } from "../../__tests__/_harness.js";
import { setValuesCandidates } from "../common.js";
import { IntegrationProcedureParser } from "../integration-procedure.js";
import { resolveVlocityNameMatches } from "../name-match-resolver.js";
import { OmniScriptParser } from "../omni-script.js";

/**
 * Task 14 batch P, rule 10: a Set Values element can hold the name of an
 * Integration Procedure that a later step runs by reference
 * (`elementValueMap: {RollupIPName: "Bundle_GroupRollups"}`). The
 * literal values are recorded as name-match candidates; the name-match
 * resolver links the ones that are exactly one existing IP / DR / OmniScript.
 */
const setValues = (map: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({
  Name: "SetIPName",
  Type: "Set Values",
  propertySet: { elementValueMap: map, ...extra },
});

describe("Set Values name-match candidates", () => {
  it("takes literal identifier values only (no merge fields, spaces, numbers, paths)", () => {
    const dp = {
      Element: [
        setValues({
          RollupIPName: "Bundle_GroupRollups",
          BatchSize: 1,
          Ref: "%SetValues:IPName%",
          Label: "IP - Acme/Order Push",
          Path: "Acme/SubmitOrderAuto",
          Nested: { Deep: "Not_Taken" },
        }),
        { Name: "Other", Type: "DataRaptor Extract Action", propertySet: { bundle: "DR_X" } },
      ],
    };
    expect(setValuesCandidates(dp)).toEqual(["Bundle_GroupRollups"]);
  });

  it("OmniScript and IP nodes carry the candidates; the resolver links existing targets", async () => {
    const dp = {
      Element: [setValues({ A: "Bundle_GroupRollups", B: "Bundle_Missing" })],
    };
    const ctx = makeTestCtx();
    const os = await new OmniScriptParser().parse({ name: "MS_Price_English", datapack: dp }, ctx);
    const ip = await new IntegrationProcedureParser().parse(
      { name: "MS_StartPrice", datapack: dp },
      ctx,
    );
    const osNode = os.nodes.find((n) => n.label === "OmniScript");
    expect((osNode?.attributes as Record<string, unknown>).nameMatchCandidates).toEqual([
      "Bundle_GroupRollups",
      "Bundle_Missing",
    ]);
    const orgId = asOrgId(String(osNode?.orgId));
    const store = new SqliteGraphStore({ dbPath: ":memory:" });
    await store.init();
    store.upsertOrg({
      id: orgId,
      alias: "t",
      instanceUrl: "https://example.test",
      apiVersion: "59.0",
      createdAt: Date.now(),
    });
    const ts = Date.now();
    store.mergeNodes([
      ...os.nodes,
      ...ip.nodes,
      {
        orgId,
        qualifiedName: asQualifiedName("IntegrationProcedure:Bundle_GroupRollups"),
        label: "IntegrationProcedure",
        attributes: {},
        sourceHash: asSha256("x"),
        firstSeenAt: ts,
        lastSeenAt: ts,
        lastModifiedAt: ts,
      },
    ]);
    resolveVlocityNameMatches(store, orgId, ctx);
    for (const src of ["OmniScript:MS_Price_English", "IntegrationProcedure:MS_StartPrice"]) {
      const refs = store
        .listEdgesFrom(orgId, asQualifiedName(src), REL_TYPES.REFERENCES)
        .map((e) => [
          String(e.dstQualifiedName),
          (e.attributes as Record<string, unknown>).inferred,
        ]);
      expect(refs, src).toEqual([["IntegrationProcedure:Bundle_GroupRollups", "name-match"]]);
    }
  });
});
