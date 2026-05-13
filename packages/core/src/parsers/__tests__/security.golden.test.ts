import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, it } from "vitest";
import { PermissionSetParser, ProfileParser, SharingRulesParser } from "../security/index.js";
import { runGolden } from "./_harness.js";

const FIX = path.resolve(__dirname, "fixtures/security");

describe("security golden", () => {
  it("parses System_Administrator profile", async () => {
    const xml = readFileSync(path.join(FIX, "System_Administrator.profile-meta.xml"), "utf8");
    await runGolden(
      new ProfileParser(),
      { name: "System_Administrator", xml },
      path.join(FIX, "System_Administrator.expected.json"),
    );
  });

  it("parses Sales_User permission set", async () => {
    const xml = readFileSync(path.join(FIX, "Sales_User.permissionset-meta.xml"), "utf8");
    await runGolden(
      new PermissionSetParser(),
      { name: "Sales_User", xml },
      path.join(FIX, "Sales_User.expected.json"),
    );
  });

  it("parses Account sharing rules", async () => {
    const xml = readFileSync(path.join(FIX, "Account.sharingRules-meta.xml"), "utf8");
    await runGolden(
      new SharingRulesParser(),
      { object: "Account", xml },
      path.join(FIX, "Account.sharingRules.expected.json"),
    );
  });
});
