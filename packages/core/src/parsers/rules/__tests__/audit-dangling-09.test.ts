import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { ConsoleLogger, asOrgId, asQualifiedName, asSha256 } from "@ryanstark24/sfgraph-shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FilesystemMetadataSource } from "../../../extractors/filesystem/index.js";
import { liveIngest } from "../../../ingest/live-ingest.js";
import { offlineResolvedOrg } from "../../../ingest/offline-org.js";
import { SqliteGraphStore } from "../../../storage/sqlite/graph-store.js";
import { retargetApexInterfaceRefs } from "../../apex/interface-ref-resolver.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "sfg-audit-parsers-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));
function w(rel: string, c: string) {
  const abs = path.join(dir, rel);
  mkdirSync(path.dirname(abs), { recursive: true });
  writeFileSync(abs, c, "utf8");
}
async function ingest() {
  w("sfdx-project.json", JSON.stringify({ packageDirectories: [{ path: "force-app" }] }));
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
  return { graphStore, orgId: resolved.orgId };
}
const D = "force-app/main/default";

/**
 * Audit dangling-09: Profile/PermissionSet GRANTS_APEX_ACCESS always targets
 * ApexClass:<name>, so a grant on an interface dangles (the node is
 * ApexInterface:<name>).
 */
describe("audit dangling-09: apex grants on an interface resolve", () => {
  it("resolves a Profile classAccess on an interface to an existing node", async () => {
    w(`${D}/classes/IHandler.cls`, "public interface IHandler { void run(); }");
    w(
      `${D}/classes/IHandler.cls-meta.xml`,
      '<?xml version="1.0" encoding="UTF-8"?><ApexClass xmlns="http://soap.sforce.com/2006/04/metadata"><apiVersion>59.0</apiVersion><status>Active</status></ApexClass>',
    );
    w(
      `${D}/profiles/Admin.profile-meta.xml`,
      '<?xml version="1.0" encoding="UTF-8"?><Profile xmlns="http://soap.sforce.com/2006/04/metadata"><classAccesses><apexClass>IHandler</apexClass><enabled>true</enabled></classAccesses></Profile>',
    );
    const { graphStore, orgId } = await ingest();
    expect(graphStore.getNode(orgId, "ApexInterface:IHandler" as never)).not.toBeNull();
    const grants = graphStore
      .listEdgesFrom(orgId, "Profile:Admin" as never)
      .filter((e) => String(e.relType) === "GRANTS_APEX_ACCESS");
    expect(grants).toHaveLength(1);
    expect(graphStore.getNode(orgId, grants[0]?.dstQualifiedName as never)).not.toBeNull();
  });

  it("moves only exact-name refs, and only when no ApexClass twin exists", async () => {
    const orgId = asOrgId("org_test");
    const store = new SqliteGraphStore({ dbPath: ":memory:" });
    await store.init();
    store.upsertOrg({
      id: orgId,
      alias: "t",
      instanceUrl: "https://example.test",
      apiVersion: "59.0",
      createdAt: Date.now(),
    });
    const ts = Date.now();
    const n = (qn: string) => ({
      orgId,
      qualifiedName: asQualifiedName(qn),
      label: qn.split(":")[0] as string,
      attributes: {},
      sourceHash: asSha256(qn),
      firstSeenAt: ts,
      lastSeenAt: ts,
      lastModifiedAt: ts,
    });
    store.mergeNodes([n("ApexInterface:I_X"), n("ApexInterface:Both"), n("ApexClass:Both")]);
    const g = (dst: string) => ({
      orgId,
      srcQualifiedName: asQualifiedName("PermissionSet:P"),
      dstQualifiedName: asQualifiedName(dst),
      relType: "GRANTS_APEX_ACCESS" as never,
      attributes: { enabled: true },
      firstSeenAt: ts,
      lastSeenAt: ts,
    });
    store.mergeEdges([g("ApexClass:I_X"), g("ApexClass:IyX"), g("ApexClass:Both")]);
    expect(retargetApexInterfaceRefs(store, orgId)).toBe(1);
    expect(retargetApexInterfaceRefs(store, orgId)).toBe(0);
    const dsts = store
      .listEdgesFrom(orgId, asQualifiedName("PermissionSet:P"))
      .map((e) => String(e.dstQualifiedName))
      .sort();
    expect(dsts).toEqual(["ApexClass:Both", "ApexClass:IyX", "ApexInterface:I_X"]);
  });

  it("review M-3: a failure between delete and re-merge loses no grant", async () => {
    const orgId = asOrgId("org_test");
    const store = new SqliteGraphStore({ dbPath: ":memory:" });
    await store.init();
    store.upsertOrg({
      id: orgId,
      alias: "t",
      instanceUrl: "https://example.test",
      apiVersion: "59.0",
      createdAt: Date.now(),
    });
    const ts = Date.now();
    store.mergeNodes([
      {
        orgId,
        qualifiedName: asQualifiedName("ApexInterface:IH"),
        label: "ApexInterface",
        attributes: {},
        sourceHash: asSha256("IH"),
        firstSeenAt: ts,
        lastSeenAt: ts,
        lastModifiedAt: ts,
      },
    ]);
    store.mergeEdges([
      {
        orgId,
        srcQualifiedName: asQualifiedName("Profile:Admin"),
        dstQualifiedName: asQualifiedName("ApexClass:IH"),
        relType: "GRANTS_APEX_ACCESS" as never,
        attributes: { enabled: true },
        firstSeenAt: ts,
        lastSeenAt: ts,
      },
    ]);
    const failing = new Proxy(store, {
      get(target, prop) {
        if (prop === "mergeEdges")
          return () => {
            throw new Error("disk full");
          };
        const v = Reflect.get(target, prop, target);
        return typeof v === "function" ? v.bind(target) : v;
      },
    });
    expect(() => retargetApexInterfaceRefs(failing, orgId)).toThrow("disk full");
    const dsts = store
      .listEdgesFrom(orgId, asQualifiedName("Profile:Admin"))
      .map((e) => String(e.dstQualifiedName));
    expect(dsts).toEqual(["ApexClass:IH"]);
  });
});
