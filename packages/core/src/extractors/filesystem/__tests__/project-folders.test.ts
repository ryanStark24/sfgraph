import { mkdirSync, mkdtempSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FilesystemMetadataSource } from "../index.js";

/**
 * S-1.8.1-001 (everyday folders + suffix fallback), -004 (fields beside the
 * object file), -005 (children-only standard objects), -007 (page shapes).
 */

const MD = "force-app/main/default";
let workDir: string;

beforeEach(() => {
  workDir = mkdtempSync(path.join(tmpdir(), "sfg-pf-"));
});
afterEach(() => {
  rmSync(workDir, { recursive: true, force: true });
});

function w(rel: string, content = "<x/>"): void {
  const abs = path.join(workDir, rel);
  mkdirSync(path.dirname(abs), { recursive: true });
  writeFileSync(abs, content, "utf8");
}

interface Got {
  type: string;
  name: string;
  content: string;
}

async function collect(src = FilesystemMetadataSource.fromProjectRoot(workDir)): Promise<Got[]> {
  const out: Got[] = [];
  for await (const m of src.iter()) {
    out.push({ type: m.ref.memberType, name: m.ref.memberName, content: m.content });
  }
  return out;
}

const keys = (g: Got[]): string[] => g.map((m) => `${m.type}:${m.name}`).sort();

describe("S-1.8.1-001: everyday metadata folders", () => {
  const FILES: Array<[string, string]> = [
    ["roles/Sales_Lead.role-meta.xml", "Role:Sales_Lead"],
    ["groups/Support_Team.group-meta.xml", "Group:Support_Team"],
    ["queues/Order_Queue.queue-meta.xml", "Queue:Order_Queue"],
    ["reports/Acme_Reports/Open_Orders.report-meta.xml", "Report:Acme_Reports/Open_Orders"],
    ["reportTypes/Orders_With_Items.reportType-meta.xml", "ReportType:Orders_With_Items"],
    ["dashboards/Acme_Dash/Order_Board.dashboard-meta.xml", "Dashboard:Acme_Dash/Order_Board"],
    ["quickActions/Account.New_Order.quickAction-meta.xml", "QuickAction:Account.New_Order"],
    ["staticresources/Logo.resource-meta.xml", "StaticResource:Logo"],
    ["email/Acme_Mail/Welcome.email-meta.xml", "EmailTemplate:Acme_Mail/Welcome"],
    ["flowDefinitions/Order_Flow.flowDefinition-meta.xml", "FlowDefinition:Order_Flow"],
    ["translations/fr.translation-meta.xml", "Translations:fr"],
    ["customPermissions/Approve_All.customPermission-meta.xml", "CustomPermission:Approve_All"],
    ["globalValueSets/Colours.globalValueSet-meta.xml", "GlobalValueSet:Colours"],
    ["standardValueSets/LeadSource.standardValueSet-meta.xml", "StandardValueSet:LeadSource"],
    ["connectedApps/Example_App.connectedApp-meta.xml", "ConnectedApp:Example_App"],
    ["applications/Sales_Console.app-meta.xml", "CustomApplication:Sales_Console"],
    ["remoteSiteSettings/Example_Site.remoteSite-meta.xml", "RemoteSiteSetting:Example_Site"],
    ["authproviders/Example_Auth.authprovider-meta.xml", "AuthProvider:Example_Auth"],
    ["topicsForObjects/Account.topicsForObjects-meta.xml", "TopicsForObjects:Account"],
    ["settings/Account.settings-meta.xml", "Settings:Account"],
    ["pathAssistants/Order_Path.pathAssistant-meta.xml", "PathAssistant:Order_Path"],
    ["namedCredentials/Example_Cred.namedCredential-meta.xml", "NamedCredential:Example_Cred"],
    ["customMetadata/Cfg.Default.md-meta.xml", "CustomMetadata:Cfg.Default"],
  ];

  it("gives one node per file in every listed folder", async () => {
    for (const [rel] of FILES) w(`${MD}/${rel}`);
    const got = keys(await collect());
    expect(got).toEqual(FILES.map(([, k]) => k).sort());
  });

  it("falls back to an opaque member typed from the suffix for an unknown folder", async () => {
    w(`${MD}/gadgets/Left.gadget-meta.xml`);
    w(`${MD}/gadgets/Sub/Right.gadget-meta.xml`);
    const got = await collect();
    expect(keys(got)).toEqual(["Gadget:Left", "Gadget:Sub/Right"]);
    const src = FilesystemMetadataSource.fromProjectRoot(workDir);
    for await (const e of src.iterIndexed()) expect(e.memberType).toBe("Gadget");
  });

  it("S-1.8.1-014: an upper-case suffix maps to the proper type, in a known folder and in the fallback", async () => {
    w(`${MD}/roles/Sales_Lead.ROLE-meta.xml`);
    w(`${MD}/staticresources/Logo.Resource-meta.xml`);
    w(`${MD}/gadgets/Left.GADGET-meta.xml`);
    w(`${MD}/other/Acme_Dept.ROLE-meta.xml`); // no spec for the folder: suffix table
    const got = keys(await collect());
    expect(got).toEqual(
      ["GADGET:Left", "Role:Acme_Dept", "Role:Sales_Lead", "StaticResource:Logo"].sort(),
    );
  });

  it("never double-counts files other specs claim", async () => {
    w(`${MD}/classes/Svc.cls`, "public class Svc {}");
    w(`${MD}/classes/Svc.cls-meta.xml`);
    w(`${MD}/pages/Home.page`, "<apex:page/>");
    w(`${MD}/pages/Home.page-meta.xml`);
    w(`${MD}/lwc/cmp/cmp.js`, "export default class Cmp {}");
    w(`${MD}/lwc/cmp/cmp.js-meta.xml`);
    w(`${MD}/aura/Old/Old.cmp`, "<aura:component/>");
    w(`${MD}/aura/Old/Old.cmp-meta.xml`);
    w(`${MD}/flows/Run.flow-meta.xml`, "<Flow/>");
    w(`${MD}/bots/Helper/Helper.bot-meta.xml`);
    w(`${MD}/objects/Widget__c/Widget__c.object-meta.xml`, "<CustomObject/>");
    w(`${MD}/objects/Widget__c/fields/Size__c.field-meta.xml`);
    w(`${MD}/objects/Widget__c/listViews/All.listView-meta.xml`);
    w(`${MD}/staticresources/Logo.resource-meta.xml`);
    w(`${MD}/staticresources/Logo.png`, "not xml");
    w(`${MD}/staticresources/Bundle/readme-meta.xml`);
    const got = keys(await collect());
    expect(got).toEqual(
      [
        "ApexClass:Svc",
        "ApexPage:Home",
        "LightningComponentBundle:cmp",
        "AuraDefinitionBundle:Old",
        "Flow:Run",
        "Bot:Helper",
        "CustomObject:Widget__c",
        "StaticResource:Logo",
      ].sort(),
    );
    expect(new Set(got).size).toBe(got.length);
  });

  it("yields a file once when metadata sits at the package root and under main/default", async () => {
    w("force-app/classes/Top.cls", "public class Top {}");
    w(`${MD}/flows/Run.flow-meta.xml`, "<Flow/>");
    w(`${MD}/gadgets/G.gadget-meta.xml`);
    w("force-app/gizmos/Z.gizmo-meta.xml");
    const src = FilesystemMetadataSource.fromProjectRoot(workDir);
    const uris: string[] = [];
    for await (const e of src.iterIndexed()) uris.push(e.key);
    expect(new Set(uris).size).toBe(uris.length);
    expect(keys(await collect())).toEqual(["ApexClass:Top", "Flow:Run", "Gadget:G", "Gizmo:Z"]);
  });

  it("reads folders under another subroot of the package directory", async () => {
    w(`${MD}/classes/Svc.cls`, "public class Svc {}");
    w("force-app/extras/default/gadgets/Extra.gadget-meta.xml");
    w("force-app/extras/default/pages/Extra.page", "<apex:page/>");
    expect(keys(await collect())).toEqual(["ApexClass:Svc", "ApexPage:Extra", "Gadget:Extra"]);
  });
});

describe("S-1.8.1-004: fields beside the object file", () => {
  it("indexes *.field-meta.xml placed directly in objects/<Obj>/", async () => {
    w(`${MD}/objects/Acme_Order__c/Acme_Order__c.object-meta.xml`, "<CustomObject/>");
    w(`${MD}/objects/Acme_Order__c/Total__c.field-meta.xml`, "<CustomField/>");
    w(`${MD}/objects/Acme_Order__c/fields/Status__c.field-meta.xml`, "<CustomField/>");
    const objs = (await collect()).filter((m) => m.type === "CustomObject");
    expect(objs).toHaveLength(1);
    const p = JSON.parse(objs[0]?.content ?? "{}") as { fields: Record<string, string> };
    expect(Object.keys(p.fields).sort()).toEqual(["Status__c", "Total__c"]);
  });

  it("makes a stub for an object folder holding only direct fields, and notices edits", async () => {
    w(`${MD}/objects/Widget__c/Size__c.field-meta.xml`, "<CustomField/>");
    const src = () => FilesystemMetadataSource.fromProjectRoot(workDir);
    const fp = async () => {
      const out: string[] = [];
      for await (const e of src().iterIndexed()) out.push(e.fingerprint);
      return out;
    };
    const before = await fp();
    expect(before).toHaveLength(1);
    const abs = path.join(workDir, MD, "objects/Widget__c/Size__c.field-meta.xml");
    writeFileSync(abs, "<CustomField><label>Changed</label></CustomField>");
    utimesSync(abs, new Date(), new Date(Date.now() + 5000));
    expect(await fp()).not.toEqual(before);
  });
});

describe("S-1.8.1-005: children-only standard objects", () => {
  it("indexes recordTypes and validationRules with no object file and no fields/", async () => {
    w(`${MD}/objects/Campaign/recordTypes/Event.recordType-meta.xml`, "<RecordType/>");
    w(
      `${MD}/objects/Campaign/validationRules/Need_Date.validationRule-meta.xml`,
      "<ValidationRule/>",
    );
    w(`${MD}/objects/Empty__c/listViews/All.listView-meta.xml`, "<ListView/>");
    const objs = (await collect()).filter((m) => m.type === "CustomObject");
    expect(objs.map((o) => o.name)).toEqual(["Campaign"]);
    const p = JSON.parse(objs[0]?.content ?? "{}") as {
      stub?: boolean;
      recordTypes: Record<string, string>;
      validationRules: Record<string, string>;
    };
    expect(p.stub).toBe(true);
    expect(Object.keys(p.recordTypes)).toEqual(["Event"]);
    expect(Object.keys(p.validationRules)).toEqual(["Need_Date"]);
  });

  it("changes the object's fingerprint when a record type is edited", async () => {
    w(`${MD}/objects/Campaign/recordTypes/Event.recordType-meta.xml`, "<RecordType/>");
    const fp = async () => {
      const out: string[] = [];
      for await (const e of FilesystemMetadataSource.fromProjectRoot(workDir).iterIndexed()) {
        out.push(e.fingerprint);
      }
      return out;
    };
    const before = await fp();
    const abs = path.join(workDir, MD, "objects/Campaign/recordTypes/Event.recordType-meta.xml");
    writeFileSync(abs, "<RecordType><label>Changed</label></RecordType>");
    utimesSync(abs, new Date(), new Date(Date.now() + 5000));
    expect(await fp()).not.toEqual(before);
  });
});

describe("S-1.8.1-007: Visualforce page shapes", () => {
  it("finds a page in another subroot, with dots in its name, and behind a file symlink", async () => {
    w(`${MD}/pages/Plain.page`, "<apex:page/>");
    w(`${MD}/pages/Name.With.Dots.page`, "<apex:page/>");
    w("force-app/other/default/pages/Elsewhere.page", "<apex:page/>");
    w("shared/Linked.page", "<apex:page/>");
    symlinkSync(
      path.join(workDir, "shared/Linked.page"),
      path.join(workDir, MD, "pages/Linked.page"),
    );
    const pages = (await collect()).filter((m) => m.type === "ApexPage").map((m) => m.name);
    expect(pages.sort()).toEqual(["Elsewhere", "Linked", "Name.With.Dots", "Plain"]);
  });

  it("finds a page in a non-default package directory", async () => {
    w("sfdx-project.json", JSON.stringify({ packageDirectories: [{ path: "a" }, { path: "b" }] }));
    w("a/main/default/pages/One.page", "<apex:page/>");
    w("b/main/default/pages/Two.page", "<apex:page/>");
    const pages = (await collect()).filter((m) => m.type === "ApexPage").map((m) => m.name);
    expect(pages.sort()).toEqual(["One", "Two"]);
  });
});
