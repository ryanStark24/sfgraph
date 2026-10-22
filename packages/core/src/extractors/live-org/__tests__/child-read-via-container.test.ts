import { asOrgId } from "@ryanstark24/sfgraph-shared";
import { beforeEach, describe, expect, it } from "vitest";
import { CHILD_READ_VIA_CONTAINER, type IngestSkipReport, bulkRetrieve } from "../bulk-retrieve.js";
import type { OrgCapabilities } from "../capabilities.js";
import { limiter, metadataPool } from "../rate-limit.js";
import { buildJsforceMock } from "./_jsforce-mock.js";

/**
 * Child types that are listable but not readable on their own (AssignmentRule,
 * EscalationRule, WorkflowFlowAutomation, ...) failed on every member with
 * "unexpected metadata" and filled the skip report, although their container
 * (AssignmentRules, Workflow, ...) had already read them.
 */

const caps = {
  detectedNamespaces: [],
  vlocityNamespaces: [],
  vlocityLegacy: false,
  vlocityCmt: false,
  omnistudioOncore: false,
  agentforce: false,
  experienceCloud: false,
  sourceTracking: false,
} as unknown as OrgCapabilities;

beforeEach(async () => {
  await metadataPool.incrementReservoir(10_000);
  await limiter.incrementReservoir(10_000);
});

async function listedTypes(metadataObjects: { xmlName: string; childXmlNames: string[] }[]) {
  const listed = new Set<string>();
  const conn = buildJsforceMock({});
  conn.metadata.describe = async () => ({ metadataObjects });
  conn.metadata.list = async (req: { type: string }[] | { type: string }) => {
    for (const q of Array.isArray(req) ? req : [req]) listed.add(q.type);
    return [];
  };
  const skipReport: IngestSkipReport = { skips: [] };
  for await (const _ of bulkRetrieve(conn, caps, asOrgId("00Dxx0000000C1dAAA"), {
    skipReport,
  })) {
    /* consume */
  }
  return listed;
}

describe("child types read through their container", () => {
  it("skips a child whose container is dispatched", async () => {
    const listed = await listedTypes([
      { xmlName: "Workflow", childXmlNames: ["WorkflowRule", "WorkflowFlowAutomation"] },
      { xmlName: "AssignmentRules", childXmlNames: ["AssignmentRule"] },
      { xmlName: "AutoResponseRules", childXmlNames: ["AutoResponseRule"] },
      { xmlName: "EscalationRules", childXmlNames: ["EscalationRule"] },
      { xmlName: "ManagedTopics", childXmlNames: ["ManagedTopic"] },
    ]);
    for (const [child, container] of CHILD_READ_VIA_CONTAINER) {
      expect(listed.has(container), container).toBe(true);
      expect(listed.has(child), child).toBe(false);
    }
    // Readable children of the same container are still routed.
    expect(listed.has("WorkflowRule")).toBe(true);
  });

  it("still tries the child when its container is not in this org's describe", async () => {
    const listed = await listedTypes([
      { xmlName: "SomethingElse", childXmlNames: ["AssignmentRule"] },
    ]);
    expect(listed.has("AssignmentRule")).toBe(true);
  });
});
