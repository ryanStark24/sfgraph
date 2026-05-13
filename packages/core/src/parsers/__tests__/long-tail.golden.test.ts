import path from "node:path";
import { beforeAll, describe, it } from "vitest";
import type { Parser } from "../contract.js";
import { OpaqueNodeParser } from "../generic/index.js";
import { parserRegistry } from "../registry.js";
import { loadAllRules } from "../rules/_loader.js";
import { runGolden } from "./_harness.js";

const FIX = path.resolve(__dirname, "fixtures/long-tail");
const expected = (n: string): string => path.join(FIX, `${n}.expected.json`);

function getParser(type: string): Parser<unknown> {
  const p = parserRegistry.for(type);
  if (!p) throw new Error(`Parser not registered for type ${type}`);
  return p;
}

describe("long-tail parsers golden", () => {
  beforeAll(async () => {
    await loadAllRules();
  });

  it("ApexPage", async () => {
    await runGolden(
      getParser("ApexPage"),
      {
        name: "MyPage",
        xml: '<?xml version="1.0"?><ApexPage xmlns="http://soap.sforce.com/2006/04/metadata"><apiVersion>59.0</apiVersion><label>My Page</label></ApexPage>',
        body: '<apex:page controller="MyController" extensions="ExtA,ExtB" />',
      },
      expected("apex-page"),
    );
  });

  it("ApexComponent", async () => {
    await runGolden(
      getParser("ApexComponent"),
      {
        name: "MyComponent",
        xml: '<?xml version="1.0"?><ApexComponent><apiVersion>59.0</apiVersion><label>Cmp</label></ApexComponent>',
        body: '<apex:component controller="CmpCtrl" />',
      },
      expected("apex-component"),
    );
  });

  it("LightningPage", async () => {
    await runGolden(
      getParser("FlexiPage"),
      {
        name: "Account_Record_Page",
        xml: '<?xml version="1.0"?><FlexiPage><type>RecordPage</type><sobjectType>Account</sobjectType><flexiPageRegions><itemInstances><componentInstance><componentName>c:MyLwc</componentName></componentInstance></itemInstances></flexiPageRegions></FlexiPage>',
      },
      expected("flexi-page"),
    );
  });

  it("Layout", async () => {
    await runGolden(
      getParser("Layout"),
      {
        name: "Account-Account Layout",
        xml: '<?xml version="1.0"?><Layout><layoutSections><layoutColumns><layoutItems><field>Name</field></layoutItems><layoutItems><field>CustomField__c</field></layoutItems></layoutColumns></layoutSections></Layout>',
      },
      expected("layout"),
    );
  });

  it("Report", async () => {
    await runGolden(
      getParser("Report"),
      {
        name: "Pipeline",
        xml: '<?xml version="1.0"?><Report><reportType>Opportunity</reportType><columns><field>Amount</field></columns><columns><field>StageName</field></columns></Report>',
      },
      expected("report"),
    );
  });

  it("Dashboard", async () => {
    await runGolden(
      getParser("Dashboard"),
      {
        name: "SalesDash",
        xml: '<?xml version="1.0"?><Dashboard><title>Sales</title><components><report>Pipeline</report></components></Dashboard>',
      },
      expected("dashboard"),
    );
  });

  it("GenAiPlanner", async () => {
    await runGolden(
      getParser("GenAiPlanner"),
      {
        name: "TopicPlanner",
        xml: '<?xml version="1.0"?><GenAiPlanner><genAiPlugins><genAiPluginName>MyPlugin</genAiPluginName></genAiPlugins></GenAiPlanner>',
      },
      expected("gen-ai-planner"),
    );
  });

  it("GenAiPlugin", async () => {
    await runGolden(
      getParser("GenAiPlugin"),
      {
        name: "MyPlugin",
        xml: '<?xml version="1.0"?><GenAiPlugin><genAiFunctions><functionName>DoX</functionName></genAiFunctions></GenAiPlugin>',
      },
      expected("gen-ai-plugin"),
    );
  });

  it("Network", async () => {
    await runGolden(
      getParser("Network"),
      {
        name: "Customer Community",
        xml: '<?xml version="1.0"?><Network><status>Live</status><communityBundles>MyExpBundle</communityBundles></Network>',
      },
      expected("network"),
    );
  });

  it("Workflow", async () => {
    await runGolden(
      getParser("Workflow"),
      {
        object: "Account",
        xml: '<?xml version="1.0"?><Workflow><rules><fullName>Rule1</fullName><active>true</active></rules><fieldUpdates><fullName>SetName</fullName><field>Name</field></fieldUpdates></Workflow>',
      },
      expected("workflow"),
    );
  });

  it("ApprovalProcess", async () => {
    await runGolden(
      getParser("ApprovalProcess"),
      {
        name: "Account.Approval1",
        xml: '<?xml version="1.0"?><ApprovalProcess><active>true</active><entryCriteria><formula>Amount__c > 1000</formula></entryCriteria></ApprovalProcess>',
      },
      expected("approval-process"),
    );
  });

  it("DuplicateRule", async () => {
    await runGolden(
      getParser("DuplicateRule"),
      {
        name: "Account.NoDups",
        xml: '<?xml version="1.0"?><DuplicateRule><isActive>true</isActive><duplicateRuleMatchRules><matchingRule>Account.Match1</matchingRule></duplicateRuleMatchRules></DuplicateRule>',
      },
      expected("duplicate-rule"),
    );
  });

  it("CustomMetadataRecord", async () => {
    await runGolden(
      getParser("CustomMetadata"),
      {
        name: "Config__mdt.Default",
        xml: '<?xml version="1.0"?><CustomMetadata><label>Default</label></CustomMetadata>',
        kind: "record",
      },
      expected("custom-metadata"),
    );
  });

  it("CustomLabels", async () => {
    await runGolden(
      getParser("CustomLabels"),
      {
        xml: '<?xml version="1.0"?><CustomLabels><labels><fullName>Hello</fullName><value>World</value><language>en_US</language></labels></CustomLabels>',
      },
      expected("custom-labels"),
    );
  });

  it("PermissionSetGroup", async () => {
    await runGolden(
      getParser("PermissionSetGroup"),
      {
        name: "SalesGroup",
        xml: '<?xml version="1.0"?><PermissionSetGroup><label>Sales</label><permissionSets>Sales_User</permissionSets></PermissionSetGroup>',
      },
      expected("permission-set-group"),
    );
  });

  it("OpaqueNode fallback", async () => {
    await runGolden(
      new OpaqueNodeParser(),
      { metadataType: "AssignmentRule", name: "Lead.Auto", raw: "<AssignmentRule/>" },
      expected("opaque"),
    );
  });
});
