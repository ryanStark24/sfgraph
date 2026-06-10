import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, it } from "vitest";
import {
  omniDataTransformParser,
  omniProcessParser,
  omniUiCardParser,
} from "../omnistudio/index.js";
import { runGolden } from "./_harness.js";

/**
 * Golden tests for the OmniStudio on-Core parsers. Fixtures are derived from
 * the SFDC-Assets/gps-dod-omnistudio-travel-application repo (Apache 2.0)
 * and redacted by the fixture-extract script:
 * - Salesforce record IDs replaced with deterministic stand-ins
 * - Secrets-shaped fields removed
 * Provenance keys (__source__, __license__, etc.) live at the top level of
 * each .input.json — they're inert to the parsers (no Type/propertySet keys)
 * but do show up inside `raw` on the produced node, which is fine: the test
 * captures the deterministic output regardless.
 */
const FIXTURES_DIR = path.join(import.meta.dirname, "fixtures", "omnistudio");

function loadFixture(file: string): unknown {
  return JSON.parse(readFileSync(path.join(FIXTURES_DIR, file), "utf8"));
}

/**
 * What each golden currently captures (regenerate with UPDATE_GOLDENS=1 after
 * intentional parser changes):
 *
 * - OmniProcess: 8 OMNI_INVOKES_REMOTE edges from the 8 elements with
 *   remote/REST action types embedded in the script. Exercises the walk() +
 *   propertySet recognition path of the OmniProcess parser.
 *
 * - OmniDataTransform: 2 edges — DR_READS_FIELD on
 *   CustomField:Travel_Request__c.Id (from the one OmniDataTransformItem
 *   row whose input side names a real SObject) plus REFERENCES_OBJECT on
 *   CustomObject:Travel_Request__c. The four json-to-json mapping rows
 *   correctly emit nothing.
 *
 * - OmniUiCard: 0 edges. The sample FlexCard has no nested IP / DataTransform
 *   / Remote references, so all three of the parser's edge branches
 *   correctly produce nothing. Confirms no-false-positive behaviour.
 */
describe("omnistudio golden", () => {
  it("OmniProcess: G2 Process (40 elements, includes DataRaptor Post Action)", async () => {
    const metadata = loadFixture("OmniProcess_TravelG2.input.json");
    await runGolden(
      omniProcessParser,
      { name: "G2_Process", metadata },
      path.join(FIXTURES_DIR, "OmniProcess_TravelG2.expected.json"),
    );
  });

  it("OmniDataTransform: extractTravelRequestInformation", async () => {
    const metadata = loadFixture("OmniDataTransform_TravelExtract.input.json");
    await runGolden(
      omniDataTransformParser,
      { name: "extractTravelRequestInformation", metadata },
      path.join(FIXTURES_DIR, "OmniDataTransform_TravelExtract.expected.json"),
    );
  });

  it("OmniUiCard: LaunchOSAppInADay FlexCard", async () => {
    const metadata = loadFixture("OmniUiCard_LaunchInADay.input.json");
    await runGolden(
      omniUiCardParser,
      { name: "LaunchOSAppInADay", metadata },
      path.join(FIXTURES_DIR, "OmniUiCard_LaunchInADay.expected.json"),
    );
  });
});
