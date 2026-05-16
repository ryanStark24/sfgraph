import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, it } from "vitest";
import {
  DataRaptorParser,
  IntegrationProcedureParser,
  OmniScriptParser,
  VlocityCardParser,
} from "../vlocity/index.js";
import { runGolden } from "./_harness.js";

/**
 * Golden tests for the four Vlocity-CMT DataPack parsers. Fixtures are
 * redacted samples pulled from a real Vlocity-CMT org by the user; the
 * extraction prompt is in the docs (chat history) and the redaction
 * applied: Salesforce record IDs swapped for deterministic stand-ins,
 * LastModifiedDate normalised, secrets-shaped fields removed.
 *
 * Important: the fixtures are RAW `conn.query` shape (vlocity_cmt__*
 * namespaced keys, PropertySet still as JSON strings). At runtime the
 * Vlocity runner (extractors/live-org/vlocity/runner.ts) normalises this
 * before handing to parsers — stripping the namespace prefix, parsing
 * the PropertySet/Content/Definition string blobs into objects, and
 * surfacing a lowercase `propertySet` alias. `normaliseDatapack` below
 * mimics that transformation so the test exercises the same input shape
 * the parsers actually receive in production.
 */
const FIXTURES_DIR = path.join(import.meta.dirname, "fixtures", "vlocity");
const NS = "vlocity_cmt";

function loadFixture(file: string): unknown {
  return JSON.parse(readFileSync(path.join(FIXTURES_DIR, file), "utf8"));
}

/** Mirror of extractors/live-org/vlocity/runner.ts's normaliseRow. Strips
 *  the namespace prefix and the trailing `__c` from custom-field keys,
 *  parses PropertySet/Content/Definition string blobs into objects, and
 *  aliases `propertySet` (lowercase) for parser-side recognition. */
function normaliseDatapack(row: any): any {
  if (Array.isArray(row)) return row.map(normaliseDatapack);
  if (!row || typeof row !== "object") return row;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row)) {
    let key = k;
    if (key.startsWith(`${NS}__`)) key = key.slice(NS.length + 2);
    if (key.endsWith("__c")) key = key.slice(0, -3);
    out[key] = normaliseDatapack(v);
  }
  for (const blobKey of ["PropertySet", "Definition", "Content", "DefinitionFileContent"]) {
    if (typeof out[blobKey] === "string") {
      try {
        out[blobKey] = JSON.parse(out[blobKey] as string);
      } catch {
        /* leave as string */
      }
    }
  }
  if (out.PropertySet !== undefined && out.propertySet === undefined) {
    out.propertySet = out.PropertySet;
  }
  return out;
}

const dataRaptorParser = new DataRaptorParser();
const ipParser = new IntegrationProcedureParser();
const osParser = new OmniScriptParser();
const cardParser = new VlocityCardParser();

/**
 * What each golden currently captures (regenerate via UPDATE_GOLDENS=1
 * after intentional parser changes):
 *
 * - DataRaptor (AccountSearch Extract, 4 DRMapItem children): 0 edges.
 *   The DRMapItem field references use colon-separated paths
 *   (`Details:AccountNumber`) but the parser's extractFieldRefs regex
 *   matches `Object.Field`. Same known limitation as the on-core
 *   OmniDataTransform parser — file as parser bug, golden documents
 *   current behavior so the future fix surfaces as a needed refresh.
 * - IntegrationProcedure (AddQGToSalesQLIs, 3 elements): 5
 *   IP_INVOKES_REMOTE edges — one with a real target name
 *   (`vlocity_cmt.B2BCmexAppHandler`), the others fall through to
 *   `Remote:unknown`. The Integration Procedure Action element
 *   (integrationProcedureKey: CloneModifyTo_SalesQLIs) currently routes
 *   to IP_INVOKES_REMOTE rather than a distinct IP_CALLS_IP — also
 *   worth investigating.
 * - OmniScript (AccountSearch, 8 elements): 15 edges — 14
 *   OS_INVOKES_REMOTE + 1 OS_USES_DR (the DataRaptor Extract Action
 *   with bundle=AccountSearch). The OS_USES_DR edge is the high-value
 *   one — proves the parser correctly resolves DataRaptor references
 *   from OmniScript elements.
 * - VlocityCard (CampaignDetail): 0 edges. The card is a pure
 *   field-rendering card on the Campaign SObject — no nested
 *   DataRaptor / IP / LWC / Card references for the parser to walk.
 *   Confirms no-false-positive behaviour.
 */
describe("vlocity golden", () => {
  it("DataRaptor: AccountSearch (Extract, 4 field mappings)", async () => {
    const datapack = normaliseDatapack(loadFixture("DRBundle_AccountSearch.input.json"));
    await runGolden(
      dataRaptorParser,
      { name: "AccountSearch", datapack },
      path.join(FIXTURES_DIR, "DRBundle_AccountSearch.expected.json"),
    );
  });

  it("IntegrationProcedure: AddQGToSalesQLIs (Remote + IP + Response)", async () => {
    const datapack = normaliseDatapack(
      loadFixture("IntegrationProcedure_AddQGToSalesQLIs.input.json"),
    );
    await runGolden(
      ipParser,
      { name: "AddQGToSalesQLIs", datapack },
      path.join(FIXTURES_DIR, "IntegrationProcedure_AddQGToSalesQLIs.expected.json"),
    );
  });

  it("OmniScript: AccountSearch (8 elements, DataRaptor Extract Action)", async () => {
    const datapack = normaliseDatapack(loadFixture("OmniScript_AccountSearch.input.json"));
    await runGolden(
      osParser,
      { name: "AccountSearch", datapack },
      path.join(FIXTURES_DIR, "OmniScript_AccountSearch.expected.json"),
    );
  });

  it("VlocityCard: CampaignDetail (Campaign field refs)", async () => {
    const datapack = normaliseDatapack(loadFixture("VlocityCard_CampaignDetail.input.json"));
    await runGolden(
      cardParser,
      { name: "CampaignDetail", datapack },
      path.join(FIXTURES_DIR, "VlocityCard_CampaignDetail.expected.json"),
    );
  });
});
