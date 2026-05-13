import { readFileSync } from "node:fs";
import path from "node:path";
import { beforeAll, describe, it } from "vitest";
import type { Parser } from "../contract.js";
import { parserRegistry } from "../registry.js";
import { loadAllRules } from "../rules/_loader.js";
import { runGolden } from "./_harness.js";

const FIX = path.resolve(__dirname, "fixtures/integration");

function getParser(type: string): Parser<unknown> {
  const p = parserRegistry.for(type);
  if (!p) throw new Error(`Parser not registered for type ${type}`);
  return p;
}

describe("integration golden", () => {
  beforeAll(async () => {
    await loadAllRules();
  });

  it("parses Named Credential", async () => {
    const xml = readFileSync(path.join(FIX, "NC_AcmeAPI.namedCredential-meta.xml"), "utf8");
    await runGolden(
      getParser("NamedCredential"),
      { name: "NC_AcmeAPI", xml },
      path.join(FIX, "NC_AcmeAPI.expected.json"),
    );
  });

  it("parses External Service Registration", async () => {
    const xml = readFileSync(
      path.join(FIX, "ESR_Acme.externalServiceRegistration-meta.xml"),
      "utf8",
    );
    await runGolden(
      getParser("ExternalServiceRegistration"),
      { name: "ESR_Acme", xml },
      path.join(FIX, "ESR_Acme.expected.json"),
    );
  });

  it("parses Platform Event (__e)", async () => {
    const xml = readFileSync(path.join(FIX, "Order_Event__e.object-meta.xml"), "utf8");
    await runGolden(
      getParser("PlatformEvent"),
      { apiName: "Order_Event__e", xml },
      path.join(FIX, "Order_Event__e.expected.json"),
    );
  });
});
