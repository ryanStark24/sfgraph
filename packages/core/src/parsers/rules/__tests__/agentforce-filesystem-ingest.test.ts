import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { ConsoleLogger } from "@ryanstark24/sfgraph-shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FilesystemMetadataSource } from "../../../extractors/filesystem/index.js";
import { liveIngest } from "../../../ingest/live-ingest.js";
import { offlineResolvedOrg } from "../../../ingest/offline-org.js";
import { SqliteGraphStore } from "../../../storage/sqlite/graph-store.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "sfg-agentforce-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));
function w(rel: string, c: string) {
  const abs = path.join(dir, rel);
  mkdirSync(path.dirname(abs), { recursive: true });
  writeFileSync(abs, c, "utf8");
}
const D = "force-app/main/default";
const NS = 'xmlns="http://soap.sforce.com/2006/04/metadata"';

describe("project-folder ingest of Agentforce / Industries / Data Cloud metadata", () => {
  it("turns the folders into typed nodes and joined edges (not opaque name-only nodes)", async () => {
    w("sfdx-project.json", JSON.stringify({ packageDirectories: [{ path: "force-app" }] }));
    w(`${D}/classes/OrderSvc.cls`, "public class OrderSvc {}");
    w(
      `${D}/genAiFunctions/Lookup/Lookup.genAiFunction-meta.xml`,
      `<GenAiFunction ${NS}><invocationTarget>OrderSvc</invocationTarget><invocationTargetType>apex</invocationTargetType></GenAiFunction>`,
    );
    w(
      `${D}/genAiPlannerBundles/Svc/Svc.genAiPlannerBundle`,
      `<GenAiPlannerBundle ${NS}><genAiFunctions><functionName>Lookup</functionName></genAiFunctions></GenAiPlannerBundle>`,
    );
    w(
      `${D}/bots/Support/v1.botVersion-meta.xml`,
      `<BotVersion ${NS}><conversationDefinitionPlanners><genAiPlannerName>Svc</genAiPlannerName></conversationDefinitionPlanners></BotVersion>`,
    );
    w(
      `${D}/objectSourceTargetMaps/M.objectSourceTargetMap-meta.xml`,
      `<ObjectSourceTargetMap ${NS}><sourceObjectName>A__dll</sourceObjectName><targetObjectName>B__dlm</targetObjectName></ObjectSourceTargetMap>`,
    );
    const graphStore = new SqliteGraphStore({ dbPath: ":memory:" });
    await graphStore.init();
    const resolved = offlineResolvedOrg(dir, "bench");
    await liveIngest({
      alias: "bench",
      graphStore,
      mode: "full",
      preResolved: resolved,
      metadataSource: await FilesystemMetadataSource.fromProjectRoot(dir),
      logger: new ConsoleLogger("error"),
      skipSnapshot: true,
    });
    const orgId = resolved.orgId;
    expect(graphStore.getNode(orgId, "ApexClass:OrderSvc" as never)).not.toBeNull();
    expect(graphStore.getNode(orgId, "BotVersion:Support.v1" as never)).not.toBeNull();
    const fnEdges = graphStore.listEdgesFrom(orgId, "GenAiFunction:Lookup" as never);
    expect(fnEdges.map((e) => `${e.relType}>${e.dstQualifiedName}`)).toEqual(
      expect.arrayContaining(["FUNCTION_INVOKES_APEX>ApexClass:OrderSvc"]),
    );
    const planner = graphStore.listEdgesFrom(orgId, "GenAiPlanner:Svc" as never);
    expect(planner.map((e) => `${e.relType}>${e.dstQualifiedName}`)).toEqual(
      expect.arrayContaining(["PLANNER_USES_FUNCTION>GenAiFunction:Lookup"]),
    );
    const bot = graphStore.listEdgesFrom(orgId, "BotVersion:Support.v1" as never);
    expect(bot.map((e) => `${e.relType}>${e.dstQualifiedName}`)).toEqual(
      expect.arrayContaining(["BOT_USES_PLANNER>GenAiPlanner:Svc"]),
    );
    const map = graphStore.listEdgesFrom(orgId, "CustomObject:A__dll" as never);
    expect(map.map((e) => `${e.relType}>${e.dstQualifiedName}`)).toEqual(
      expect.arrayContaining(["MAPS_TO_OBJECT>CustomObject:B__dlm"]),
    );
  });
});
