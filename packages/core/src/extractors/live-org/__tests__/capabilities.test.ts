import { describe, expect, it } from "vitest";
import { probeCapabilities } from "../capabilities.js";
import { buildJsforceMock } from "./_jsforce-mock.js";

describe("probeCapabilities", () => {
  it("detects vlocity_cmt when DRBundle__c describes", async () => {
    const conn = buildJsforceMock({ describeResults: { vlocity_cmt__DRBundle__c: true } });
    const caps = await probeCapabilities(conn);
    expect(caps.vlocityCmt).toBe(true);
    expect(caps.omnistudioOncore).toBe(false);
  });

  it("detects native omnistudio when OmniProcess describes", async () => {
    const conn = buildJsforceMock({ describeResults: { OmniProcess: true } });
    const caps = await probeCapabilities(conn);
    expect(caps.omnistudioOncore).toBe(true);
    expect(caps.vlocityCmt).toBe(false);
  });

  it("detects agentforce when GenAiPlanner tooling-describes", async () => {
    const conn = buildJsforceMock({ toolingDescribeResults: { GenAiPlanner: true } });
    const caps = await probeCapabilities(conn);
    expect(caps.agentforce).toBe(true);
  });

  it("detects experience cloud when Network describes", async () => {
    const conn = buildJsforceMock({ describeResults: { Network: true } });
    const caps = await probeCapabilities(conn);
    expect(caps.experienceCloud).toBe(true);
  });

  it("detects sourceTracking when SourceMember tooling-describes; surfaces namespaces", async () => {
    const conn = buildJsforceMock({
      toolingDescribeResults: { SourceMember: true },
      toolingQueryResults: {
        "SELECT NamespacePrefix FROM PackageLicense": {
          records: [{ NamespacePrefix: "vlocity_cmt" }, { NamespacePrefix: "OmniStudio" }],
          done: true,
        },
      },
    });
    const caps = await probeCapabilities(conn);
    expect(caps.sourceTracking).toBe(true);
    expect(caps.detectedNamespaces).toEqual(["vlocity_cmt", "OmniStudio"]);
  });
});
