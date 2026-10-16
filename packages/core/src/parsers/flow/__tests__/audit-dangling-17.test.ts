import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { ConsoleLogger } from "@ryanstark24/sfgraph-shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FilesystemMetadataSource } from "../../../extractors/filesystem/index.js";
import { liveIngest } from "../../../ingest/live-ingest.js";
import { offlineResolvedOrg } from "../../../ingest/offline-org.js";
import { SqliteGraphStore } from "../../../storage/sqlite/graph-store.js";
import { makeTestCtx } from "../../__tests__/_harness.js";
import { FlowParser } from "../parser.js";

/**
 * Audit dangling-17: every non-apex actionCall becomes FLOW_INVOKES_ACTION ->
 * FlowAction:<type>:<name>. actionType=flow is really a subflow call, and
 * emailAlert targets workflow alerts that never get a node, so both dangle.
 */
const flow = (body: string) =>
  `<?xml version="1.0" encoding="UTF-8"?><Flow xmlns="http://soap.sforce.com/2006/04/metadata"><apiVersion>59.0</apiVersion>${body}</Flow>`;

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "sfg-audit-d17-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));
function w(rel: string, c: string) {
  const abs = path.join(dir, rel);
  mkdirSync(path.dirname(abs), { recursive: true });
  writeFileSync(abs, c, "utf8");
}

describe("audit dangling-17: flow actionCalls of type flow / emailAlert", () => {
  it("routes actionType=flow to FLOW_INVOKES_SUBFLOW -> Flow:<name>", async () => {
    const r = await new FlowParser().parse(
      {
        fullName: "Parent_Flow",
        xml: flow(
          "<actionCalls><name>Call_Sharing</name><actionName>Share_Accounts_Sub</actionName><actionType>flow</actionType></actionCalls>",
        ),
      },
      makeTestCtx(),
    );
    const dsts = r.edges.map((e) => `${e.relType} ${String(e.dstQualifiedName)}`);
    expect(dsts).toContain("FLOW_INVOKES_SUBFLOW Flow:Share_Accounts_Sub");
    expect(dsts.filter((d) => d.includes("FlowAction:flow:"))).toEqual([]);
  });

  it("resolves an emailAlert action to a node for the workflow alert", async () => {
    const D = "force-app/main/default";
    w("sfdx-project.json", JSON.stringify({ packageDirectories: [{ path: "force-app" }] }));
    w(
      `${D}/workflows/Case.workflow-meta.xml`,
      '<?xml version="1.0" encoding="UTF-8"?><Workflow xmlns="http://soap.sforce.com/2006/04/metadata"><alerts><fullName>Notify_Owner</fullName><description>Notify</description><protected>false</protected><recipients><type>owner</type></recipients><senderType>CurrentUser</senderType><template>unfiled$public/Case_Template</template></alerts></Workflow>',
    );
    w(
      `${D}/flows/Case_Flow.flow-meta.xml`,
      flow(
        "<actionCalls><name>Send</name><actionName>Case.Notify_Owner</actionName><actionType>emailAlert</actionType></actionCalls>",
      ),
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
    const actions = graphStore
      .listEdgesByDstLike(resolved.orgId, "%Notify_Owner%")
      .filter((e) => String(e.srcQualifiedName).startsWith("Flow"));
    expect(actions).toHaveLength(1);
    expect(
      graphStore.getNode(resolved.orgId, actions[0]?.dstQualifiedName as never),
    ).not.toBeNull();
  });
});
