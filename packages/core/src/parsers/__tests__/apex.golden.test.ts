import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, it } from "vitest";
import { ApexClassParser, ApexTriggerParser } from "../apex/index.js";
import { runGolden } from "./_harness.js";

const FIX = path.resolve(__dirname, "fixtures/apex");

describe("apex golden", () => {
  it("parses AccountController.cls", async () => {
    const body = readFileSync(path.join(FIX, "AccountController.cls"), "utf8");
    const metaXml = readFileSync(path.join(FIX, "AccountController.cls-meta.xml"), "utf8");
    await runGolden(
      new ApexClassParser(),
      { className: "AccountController", body, metaXml },
      path.join(FIX, "AccountController.expected.json"),
    );
  });

  it("parses AccountTrigger.trigger", async () => {
    const body = readFileSync(path.join(FIX, "AccountTrigger.trigger"), "utf8");
    const metaXml = readFileSync(path.join(FIX, "AccountTrigger.trigger-meta.xml"), "utf8");
    await runGolden(
      new ApexTriggerParser(),
      { triggerName: "AccountTrigger", body, metaXml },
      path.join(FIX, "AccountTrigger.expected.json"),
    );
  });

  it("parses AccountControllerTest.cls", async () => {
    const body = readFileSync(path.join(FIX, "AccountControllerTest.cls"), "utf8");
    const metaXml = readFileSync(path.join(FIX, "AccountControllerTest.cls-meta.xml"), "utf8");
    await runGolden(
      new ApexClassParser(),
      { className: "AccountControllerTest", body, metaXml },
      path.join(FIX, "AccountControllerTest.expected.json"),
    );
  });

  it("emits ParseError on broken syntax", async () => {
    const body = readFileSync(path.join(FIX, "BrokenSyntax.cls"), "utf8");
    await runGolden(
      new ApexClassParser(),
      { className: "BrokenSyntax", body },
      path.join(FIX, "BrokenSyntax.expected.json"),
    );
  });
});
