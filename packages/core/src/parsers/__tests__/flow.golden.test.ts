import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, it } from "vitest";
import { FlowParser } from "../flow/index.js";
import { runGolden } from "./_harness.js";

const FIX = path.resolve(__dirname, "fixtures/flow");

describe("flow golden", () => {
  it("parses Account_Update_Status", async () => {
    const xml = readFileSync(path.join(FIX, "Account_Update_Status.flow-meta.xml"), "utf8");
    await runGolden(
      new FlowParser(),
      { fullName: "Account_Update_Status", xml },
      path.join(FIX, "Account_Update_Status.expected.json"),
    );
  });

  it("parses Subflow_Caller", async () => {
    const xml = readFileSync(path.join(FIX, "Subflow_Caller.flow-meta.xml"), "utf8");
    await runGolden(
      new FlowParser(),
      { fullName: "Subflow_Caller", xml },
      path.join(FIX, "Subflow_Caller.expected.json"),
    );
  });
});
