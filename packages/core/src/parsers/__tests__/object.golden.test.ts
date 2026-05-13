import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { describe, it } from "vitest";
import { CustomObjectParser } from "../object/index.js";
import { runGolden } from "./_harness.js";

const FIX = path.resolve(__dirname, "fixtures/object/Account");

function readDirFiles(dir: string, suffix: string): Record<string, string> {
  const out: Record<string, string> = {};
  let entries: string[] = [];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const e of entries) {
    if (e.endsWith(suffix)) {
      const apiName = e.slice(0, -suffix.length);
      out[apiName] = readFileSync(path.join(dir, e), "utf8");
    }
  }
  return out;
}

describe("object golden", () => {
  it("parses Account dir layout", async () => {
    const objectXml = readFileSync(path.join(FIX, "Account.object-meta.xml"), "utf8");
    const fields = readDirFiles(path.join(FIX, "fields"), ".field-meta.xml");
    const recordTypes = readDirFiles(path.join(FIX, "recordTypes"), ".recordType-meta.xml");
    const validationRules = readDirFiles(
      path.join(FIX, "validationRules"),
      ".validationRule-meta.xml",
    );
    await runGolden(
      new CustomObjectParser(),
      { apiName: "Account", objectXml, fields, recordTypes, validationRules },
      path.join(FIX, "..", "Account.expected.json"),
    );
  });
});
