import { readFileSync } from "node:fs";
import path from "node:path";
import { beforeAll, describe, it } from "vitest";
import type { Parser } from "../contract.js";
import { parserRegistry } from "../registry.js";
import { loadAllRules } from "../rules/_loader.js";
import { runGolden } from "./_harness.js";

const FIX = path.resolve(__dirname, "fixtures/security");

function getParser(type: string): Parser<unknown> {
  const p = parserRegistry.for(type);
  if (!p) throw new Error(`Parser not registered for type ${type}`);
  return p;
}

describe("security golden", () => {
  beforeAll(async () => {
    await loadAllRules();
  });

  it("parses System_Administrator profile", async () => {
    const xml = readFileSync(path.join(FIX, "System_Administrator.profile-meta.xml"), "utf8");
    await runGolden(
      getParser("Profile"),
      { name: "System_Administrator", xml },
      path.join(FIX, "System_Administrator.expected.json"),
    );
  });

  it("parses Sales_User permission set", async () => {
    const xml = readFileSync(path.join(FIX, "Sales_User.permissionset-meta.xml"), "utf8");
    await runGolden(
      getParser("PermissionSet"),
      { name: "Sales_User", xml },
      path.join(FIX, "Sales_User.expected.json"),
    );
  });

  it("parses Account sharing rules", async () => {
    const xml = readFileSync(path.join(FIX, "Account.sharingRules-meta.xml"), "utf8");
    await runGolden(
      getParser("SharingRules"),
      { object: "Account", xml },
      path.join(FIX, "Account.sharingRules.expected.json"),
    );
  });
});
