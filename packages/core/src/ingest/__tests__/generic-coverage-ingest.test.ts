import { ConsoleLogger } from "@ryanstark24/sfgraph-shared";
import { describe, expect, it } from "vitest";
import { METADATA_CATEGORY } from "../../domain/index.js";
import type { MetadataSource, RawMember } from "../../extractors/interfaces/metadata-source.js";
import { SqliteGraphStore } from "../../storage/sqlite/graph-store.js";
import { liveIngest } from "../live-ingest.js";
import { offlineResolvedOrg } from "../offline-org.js";

function member(memberType: string, memberName: string, content: string): RawMember {
  return {
    ref: {
      category: METADATA_CATEGORY.OBJECT,
      memberType,
      memberName,
      lastModifiedAt: null,
      sourceUri: `mem://${memberType}/${memberName}`,
      namespace: null,
    },
    content,
  };
}

describe("generic scanner + coverage, end to end through liveIngest", () => {
  it("an unknown type gets heuristic edges, and the coverage report lists it", async () => {
    const members: RawMember[] = [
      member("ApexClass", "TierService", "public class TierService {}"),
      member(
        "CustomObject",
        "Case",
        "<CustomObject><fullName>Case</fullName><label>Case</label></CustomObject>",
      ),
      // two members of a type nothing knows about: one names real things, one nothing
      member(
        "AgentWidget",
        "W1",
        JSON.stringify({ objectName: "Case", apexClassName: "TierService", ghost: "Ghost__c" }),
      ),
      member("AgentWidget", "W2", JSON.stringify({ label: "no references here" })),
      // a type with a built-in YAML rule
      member("CustomTab", "T1", "<CustomTab><label>x</label></CustomTab>"),
      // a rule alias: arrives as GenAiPlannerBundle, becomes a GenAiPlanner node
      member(
        "GenAiPlannerBundle",
        "P1",
        "<GenAiPlannerBundle><genAiPlugins><genAiPluginName>Pl</genAiPluginName></genAiPlugins></GenAiPlannerBundle>",
      ),
    ];
    const source = {
      iter: async function* () {
        for (const m of members) yield m;
      },
    } as unknown as MetadataSource;
    const graphStore = new SqliteGraphStore({ dbPath: ":memory:" });
    await graphStore.init();
    const resolved = offlineResolvedOrg("/tmp/none", "gen");
    const res = await liveIngest({
      alias: "gen",
      graphStore,
      mode: "auto",
      preResolved: resolved,
      metadataSource: source,
      logger: new ConsoleLogger("error"),
      skipSnapshot: true,
    });
    const q = (s: string) => s as never;
    const apex = graphStore.listEdgesFrom(
      resolved.orgId,
      q("AgentWidget:W1"),
      "GENERIC_REFERENCES_APEX" as never,
    );
    expect(apex.map((e) => String(e.dstQualifiedName))).toEqual(["ApexClass:TierService"]);
    expect(
      graphStore.listEdgesFrom(
        resolved.orgId,
        q("AgentWidget:W1"),
        "GENERIC_REFERENCES_OBJECT" as never,
      ).length,
    ).toBe(1);
    expect(res.genericRefEdges).toBe(2);

    const cov = res.coverage!;
    expect(cov.byType.AgentWidget).toEqual({
      opaque: 2,
      withGenericEdges: 1,
      nameOnly: 1,
      ruleParsed: 0,
    });
    expect(cov.byType.CustomTab?.ruleParsed).toBe(1);
    // an alias (GenAiPlannerBundle) shares the GenAiPlanner row; no row of its own
    expect(cov.byType.GenAiPlanner?.ruleParsed).toBe(1);
    expect(cov.byType.GenAiPlannerBundle).toBeUndefined();
    expect(cov.unknownTypes).toContain("AgentWidget");
    // persisted for MCP
    const stored = JSON.parse(graphStore.getCoverageReport(resolved.orgId)!);
    expect(stored.byType.AgentWidget.nameOnly).toBe(1);
  });
});
