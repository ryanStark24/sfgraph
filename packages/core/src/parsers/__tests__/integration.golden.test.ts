import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, it } from "vitest";
import {
  ExternalServiceRegistrationParser,
  NamedCredentialParser,
  PlatformEventParser,
} from "../integration/index.js";
import { runGolden } from "./_harness.js";

const FIX = path.resolve(__dirname, "fixtures/integration");

describe("integration golden", () => {
  it("parses Named Credential", async () => {
    const xml = readFileSync(path.join(FIX, "NC_AcmeAPI.namedCredential-meta.xml"), "utf8");
    await runGolden(
      new NamedCredentialParser(),
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
      new ExternalServiceRegistrationParser(),
      { name: "ESR_Acme", xml },
      path.join(FIX, "ESR_Acme.expected.json"),
    );
  });

  it("parses Platform Event (__e)", async () => {
    const xml = readFileSync(path.join(FIX, "Order_Event__e.object-meta.xml"), "utf8");
    await runGolden(
      new PlatformEventParser(),
      { apiName: "Order_Event__e", xml },
      path.join(FIX, "Order_Event__e.expected.json"),
    );
  });
});
