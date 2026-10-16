import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FilesystemMetadataSource, detectVlocityNamespace } from "../index.js";

let workDir: string;

beforeEach(() => {
  workDir = mkdtempSync(path.join(tmpdir(), "sfg-fs-"));
});

afterEach(() => {
  rmSync(workDir, { recursive: true, force: true });
});

function w(rel: string, content: string): void {
  const abs = path.join(workDir, rel);
  mkdirSync(path.dirname(abs), { recursive: true });
  writeFileSync(abs, content, "utf8");
}

async function collect(
  src: FilesystemMetadataSource,
): Promise<Array<{ type: string; name: string; content: string; uri: string }>> {
  const out: Array<{ type: string; name: string; content: string; uri: string }> = [];
  for await (const m of src.iter()) {
    out.push({
      type: m.ref.memberType,
      name: m.ref.memberName,
      content: m.content,
      uri: m.ref.sourceUri,
    });
  }
  return out;
}

describe("FilesystemMetadataSource", () => {
  it("walks ApexClass and Flow", async () => {
    w("force-app/main/default/classes/Foo.cls", "public class Foo {}");
    w("force-app/main/default/classes/Foo.cls-meta.xml", "<xml/>");
    w("force-app/main/default/flows/Bar.flow-meta.xml", "<Flow/>");
    const src = new FilesystemMetadataSource(workDir);
    const members = await collect(src);
    const types = members.map((m) => m.type).sort();
    expect(types).toEqual(["ApexClass", "Flow"]);
  });

  it("walks Lightning message channels", async () => {
    w(
      "force-app/main/default/messageChannels/Record_Selected.messageChannel-meta.xml",
      "<LightningMessageChannel/>",
    );
    const members = await collect(new FilesystemMetadataSource(workDir));
    expect(members.map((m) => `${m.type}:${m.name}`)).toEqual([
      "LightningMessageChannel:Record_Selected",
    ]);
  });

  it("bundles LWC files into one RawMember", async () => {
    w("force-app/main/default/lwc/accountTile/accountTile.js", "export default class {}");
    w("force-app/main/default/lwc/accountTile/accountTile.html", "<template></template>");
    w("force-app/main/default/lwc/accountTile/accountTile.js-meta.xml", "<meta/>");
    const src = new FilesystemMetadataSource(workDir);
    const members = await collect(src);
    expect(members.length).toBe(1);
    expect(members[0]?.type).toBe("LightningComponentBundle");
    const payload = JSON.parse(members[0]?.content ?? "{}") as {
      bundleName: string;
      files: Record<string, string>;
    };
    expect(payload.bundleName).toBe("accountTile");
    expect(Object.keys(payload.files).sort()).toEqual([
      "accountTile.html",
      "accountTile.js",
      "accountTile.js-meta.xml",
    ]);
  });

  it("bundles CustomObject dir with fields", async () => {
    w("force-app/main/default/objects/Account/Account.object-meta.xml", "<CustomObject/>");
    w("force-app/main/default/objects/Account/fields/Status__c.field-meta.xml", "<CustomField/>");
    const src = new FilesystemMetadataSource(workDir);
    const members = await collect(src);
    const obj = members.find((m) => m.type === "CustomObject");
    expect(obj).toBeTruthy();
    expect(obj?.name).toBe("Account");
    const payload = JSON.parse(obj?.content ?? "{}") as {
      apiName: string;
      fields: Record<string, string>;
    };
    expect(payload.apiName).toBe("Account");
    expect(payload.fields).toHaveProperty("Status__c");
  });

  it("yields a stub CustomObject for a fields-only object folder (no object-meta.xml)", async () => {
    w("force-app/main/default/objects/Widget__c/fields/Size__c.field-meta.xml", "<CustomField/>");
    w("force-app/main/default/objects/Widget__c/listViews/All.listView-meta.xml", "<ListView/>");
    // A folder with no fields and no object-meta still yields nothing.
    w("force-app/main/default/objects/Empty__c/listViews/All.listView-meta.xml", "<ListView/>");
    const src = new FilesystemMetadataSource(workDir);
    const members = await collect(src);
    const objs = members.filter((m) => m.type === "CustomObject");
    expect(objs.map((o) => o.name)).toEqual(["Widget__c"]);
    const payload = JSON.parse(objs[0]?.content ?? "{}") as {
      apiName: string;
      objectXml: string;
      stub?: boolean;
      fields: Record<string, string>;
    };
    expect(payload.apiName).toBe("Widget__c");
    expect(payload.stub).toBe(true);
    expect(payload.objectXml).toBe("");
    expect(payload.fields).toHaveProperty("Size__c");
  });

  it("tolerates missing subdirs", async () => {
    w("force-app/main/default/classes/Solo.cls", "public class Solo {}");
    const src = new FilesystemMetadataSource(workDir);
    const members = await collect(src);
    expect(members.length).toBe(1);
    expect(members[0]?.type).toBe("ApexClass");
  });

  it("skips node_modules, .git, dist", async () => {
    w("force-app/main/default/classes/Real.cls", "public class Real {}");
    w("force-app/node_modules/foo/classes/Fake.cls", "fake");
    w("force-app/.git/classes/Fake2.cls", "fake");
    w("force-app/dist/classes/Fake3.cls", "fake");
    const src = new FilesystemMetadataSource(workDir);
    const members = await collect(src);
    expect(members.length).toBe(1);
    expect(members[0]?.name).toBe("Real");
  });

  it("fromProjectRoot honors sfdx-project.json packageDirectories", async () => {
    w("sfdx-project.json", JSON.stringify({ packageDirectories: [{ path: "custom-pkg" }] }));
    w("custom-pkg/main/default/classes/Custom.cls", "public class Custom {}");
    w("force-app/main/default/classes/ShouldBeSkipped.cls", "public class X {}");
    const src = FilesystemMetadataSource.fromProjectRoot(workDir);
    const members = await collect(src);
    const names = members.map((m) => m.name);
    expect(names).toContain("Custom");
    expect(names).not.toContain("ShouldBeSkipped");
  });
});

describe("detectVlocityNamespace", () => {
  it("returns the most frequent Vlocity namespace among object names", () => {
    expect(
      detectVlocityNamespace([
        "vlocity_ins__A__c",
        "vlocity_ins__B__c",
        "vlocity_cmt__C__c",
        "Account",
      ]),
    ).toBe("vlocity_ins");
  });

  it("breaks ties by candidate order, not by the order names are seen", () => {
    expect(detectVlocityNamespace(["vlocity_ins__A__c", "vlocity_cmt__B__c"])).toBe("vlocity_cmt");
    expect(detectVlocityNamespace(["vlocity_cmt__B__c", "vlocity_ins__A__c"])).toBe("vlocity_cmt");
  });

  it("returns null without Vlocity-namespaced objects", () => {
    expect(detectVlocityNamespace(["Account", "Widget__c"])).toBeNull();
  });
});

describe("Task 11c: iterIndexed (cheap per-member fingerprints, lazy load)", () => {
  const FIXTURE = path.resolve(__dirname, "../../../ingest/__tests__/fixtures/delta-project");

  async function indexed(root: string) {
    const src = FilesystemMetadataSource.fromProjectRoot(root);
    const out: Array<{ key: string; type: string; fp: string; m: unknown }> = [];
    for await (const e of src.iterIndexed()) {
      const m = await e.load();
      out.push({ key: e.key, type: e.memberType, fp: e.fingerprint, m });
    }
    return out;
  }

  it("load() yields exactly what iter() yields, in the same order", async () => {
    const { cpSync } = await import("node:fs");
    cpSync(FIXTURE, workDir, { recursive: true });
    const viaIter: unknown[] = [];
    for await (const m of FilesystemMetadataSource.fromProjectRoot(workDir).iter()) viaIter.push(m);
    const viaIndex = await indexed(workDir);
    expect(viaIndex.map((x) => x.m)).toEqual(viaIter);
    expect(viaIter.length).toBeGreaterThan(15);
    // Keys are the members' sourceUris and are unique.
    expect(viaIndex.map((x) => x.key)).toEqual(
      viaIter.map((m) => (m as { ref: { sourceUri: string } }).ref.sourceUri),
    );
    expect(new Set(viaIndex.map((x) => x.key)).size).toBe(viaIndex.length);
  });

  it("a fingerprint changes only for the member whose file changed", async () => {
    const { cpSync } = await import("node:fs");
    cpSync(FIXTURE, workDir, { recursive: true });
    const before = new Map((await indexed(workDir)).map((x) => [x.key, x.fp]));
    w(
      "force-app/main/default/objects/Account/fields/Tier__c.field-meta.xml",
      "<CustomField><fullName>Tier__c</fullName><type>Text</type><length>9</length></CustomField>",
    );
    w("vlocity/datapacks/DataRaptor/AcctFetch/AcctFetch_Mappings.json", "[]");
    const after = new Map((await indexed(workDir)).map((x) => [x.key, x.fp]));
    const changed = [...after].filter(([k, fp]) => before.get(k) !== fp).map(([k]) => k);
    expect(changed.map((k) => path.basename(k)).sort()).toEqual([
      "Account.object-meta.xml",
      "AcctFetch_DataPack.json",
    ]);
  });
});
