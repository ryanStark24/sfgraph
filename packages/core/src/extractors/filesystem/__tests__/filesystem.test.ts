import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FilesystemMetadataSource } from "../index.js";

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
