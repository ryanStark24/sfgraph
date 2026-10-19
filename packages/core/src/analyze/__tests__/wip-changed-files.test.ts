import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  classifyMember,
  filesModifiedSince,
  indexChanges,
  localChangedFiles,
  membersOwningFiles,
} from "../wip-changed-files.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "sfg-wipcf-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));
function w(rel: string, c = "x"): string {
  const abs = path.join(dir, rel);
  mkdirSync(path.dirname(abs), { recursive: true });
  writeFileSync(abs, c, "utf8");
  return abs;
}
const ref = (abs: string, memberName: string) => ({ sourceUri: `file://${abs}`, memberName });

describe("membersOwningFiles", () => {
  it("maps own files, sidecars, bundle folders and sole-member folders; not shared folders", () => {
    const a = w("classes/A.cls");
    const aMeta = w("classes/A.cls-meta.xml");
    const b = w("classes/B.cls");
    const stray = w("classes/README.md");
    const lwcDir = path.dirname(w("lwc/panel/panel.js"));
    const lwcHtml = w("lwc/panel/panel.html");
    const pack = w("datapacks/DataRaptor/WidgetFetch/WidgetFetch_DataPack.json");
    const mappings = w("datapacks/DataRaptor/WidgetFetch/WidgetFetch_Mappings.json");
    const objXml = w("objects/Foo__c/Foo__c.object-meta.xml");
    const field = w("objects/Foo__c/fields/Bar__c.field-meta.xml");
    const refs = [
      ref(a, "A"),
      ref(b, "B"),
      ref(lwcDir, "panel"),
      ref(pack, "WidgetFetch"),
      ref(objXml, "Foo__c"),
    ];
    const own = (files: string[]) => [...membersOwningFiles(refs, new Set(files))].sort();
    expect(own([aMeta])).toEqual([0]);
    expect(own([stray])).toEqual([]);
    expect(own([lwcHtml])).toEqual([2]);
    expect(own([mappings])).toEqual([3]);
    expect(own([field])).toEqual([4]);
    expect(own([])).toEqual([]);
  });
});

describe("localChangedFiles", () => {
  it("returns null when neither git nor a sync time is available", () => {
    w("force-app/classes/A.cls");
    expect(
      localChangedFiles({
        projectRoot: dir,
        sourceDirs: [path.join(dir, "force-app")],
        lastSyncedAt: null,
      }),
    ).toBeNull();
  });

  it("mtime signal: only files modified after the sync", () => {
    const now = Date.now();
    const old = w("force-app/classes/Old.cls");
    const fresh = w("force-app/classes/New.cls");
    utimesSync(old, new Date(now - 60_000), new Date(now - 60_000));
    utimesSync(fresh, new Date(now + 60_000), new Date(now + 60_000));
    expect([...filesModifiedSince([path.join(dir, "force-app")], now)]).toEqual([fresh]);
  });
});

// review M-2: the single-pass wip selection pre-classifies each member while
// streaming; it must never drop ("no") a member membersOwningFiles selects.
describe("classifyMember", () => {
  it("direct for own files and bundles, maybe for anchored folders, no otherwise", () => {
    const a = w("classes/A.cls");
    const aMeta = w("classes/A.cls-meta.xml");
    const b = w("classes/B.cls");
    const stray = w("classes/README.md");
    const lwcDir = path.dirname(w("lwc/panel/panel.js"));
    const lwcHtml = w("lwc/panel/panel.html");
    const pack = w("datapacks/DataRaptor/WidgetFetch/WidgetFetch_DataPack.json");
    const mappings = w("datapacks/DataRaptor/WidgetFetch/WidgetFetch_Mappings.json");
    const objXml = w("objects/Foo__c/Foo__c.object-meta.xml");
    const field = w("objects/Foo__c/fields/Bar__c.field-meta.xml");
    const refs = [
      ref(a, "A"),
      ref(b, "B"),
      ref(lwcDir, "panel"),
      ref(pack, "WidgetFetch"),
      ref(objXml, "Foo__c"),
    ];
    const kinds = (files: string[]) =>
      refs.map((r) => classifyMember(r, indexChanges(new Set(files))));
    expect(kinds([aMeta])).toEqual(["direct", "maybe", "no", "no", "no"]);
    expect(kinds([stray])).toEqual(["maybe", "maybe", "no", "no", "no"]);
    expect(kinds([lwcHtml])).toEqual(["no", "no", "direct", "no", "no"]);
    expect(kinds([mappings])).toEqual(["no", "no", "no", "maybe", "no"]);
    expect(kinds([field])).toEqual(["no", "no", "no", "no", "maybe"]);
    for (const files of [[aMeta], [stray], [lwcHtml], [mappings], [field], [a, b, field]]) {
      const k = kinds(files);
      for (const i of membersOwningFiles(refs, new Set(files))) expect(k[i]).not.toBe("no");
    }
  });
});
