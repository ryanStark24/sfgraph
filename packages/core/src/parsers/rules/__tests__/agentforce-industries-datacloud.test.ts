import { beforeAll, describe, expect, it } from "vitest";
import { makeTestCtx } from "../../__tests__/_harness.js";
import type { Parser } from "../../contract.js";
import { parserRegistry } from "../../registry.js";
import { loadAllRules } from "../_loader.js";

const NS = 'xmlns="http://soap.sforce.com/2006/04/metadata"';

function getParser(type: string): Parser<unknown> {
  const p = parserRegistry.for(type);
  if (!p) throw new Error(`no parser for ${type}`);
  return p;
}

async function run(type: string, input: unknown) {
  const r = await getParser(type).parse(input, makeTestCtx());
  const edges = r.edges.map((e) => `${e.srcQualifiedName} -${e.relType}-> ${e.dstQualifiedName}`);
  return { nodes: r.nodes, edges: edges.sort() };
}

beforeAll(async () => {
  await loadAllRules();
});

describe("GenAiPlanner / GenAiPlannerBundle / GenAiPlannerDefinition", () => {
  const xml = (root: string) =>
    `<?xml version="1.0"?><${root} ${NS}><description>Svc</description><masterLabel>Svc</masterLabel>
      <plannerType>AiCopilot__ReAct</plannerType>
      <genAiPlugins><genAiPluginName>Case_Topic</genAiPluginName></genAiPlugins>
      <genAiPlugins><genAiPluginName>Order_Topic</genAiPluginName></genAiPlugins>
      <genAiFunctions><functionName>Lookup_Order</functionName></genAiFunctions>
      <localTopics><localActions><developerName>A</developerName>
        <invocationTarget>Refund_Flow</invocationTarget><invocationTargetType>flow</invocationTargetType></localActions>
      <localActions><developerName>B</developerName>
        <invocationTarget>OrderSvc</invocationTarget><invocationTargetType>apex</invocationTargetType></localActions>
      </localTopics></${root}>`;

  for (const type of ["GenAiPlanner", "GenAiPlannerBundle", "GenAiPlannerDefinition"]) {
    it(`${type} emits the planner node and its edges`, async () => {
      const { nodes, edges } = await run(type, { name: "Svc", xml: xml(type) });
      expect(nodes.map((n) => n.qualifiedName)).toEqual(["GenAiPlanner:Svc"]);
      expect(edges).toEqual([
        "GenAiPlanner:Svc -PLANNER_INVOKES_APEX-> ApexClass:OrderSvc",
        "GenAiPlanner:Svc -PLANNER_INVOKES_FLOW-> Flow:Refund_Flow",
        "GenAiPlanner:Svc -PLANNER_USES_FUNCTION-> GenAiFunction:Lookup_Order",
        "GenAiPlanner:Svc -PLANNER_USES_PLUGIN-> GenAiPlugin:Case_Topic",
        "GenAiPlanner:Svc -PLANNER_USES_PLUGIN-> GenAiPlugin:Order_Topic",
      ]);
    });
  }

  it("reads the live JSON shape (metadata.read) too", async () => {
    const { edges } = await run("GenAiPlannerBundle", {
      xml: "",
      genAiPlugins: [{ genAiPluginName: "P1" }],
      name: "Svc",
    });
    expect(edges).toEqual(["GenAiPlanner:Svc -PLANNER_USES_PLUGIN-> GenAiPlugin:P1"]);
  });

  it("an empty bundle gives a node and no edges", async () => {
    const { nodes, edges } = await run("GenAiPlannerBundle", {
      name: "Empty",
      xml: `<GenAiPlannerBundle ${NS}/>`,
    });
    expect(nodes).toHaveLength(1);
    expect(edges).toEqual([]);
  });
});

describe("GenAiFunction", () => {
  const fn = (target: string, type: string) =>
    `<GenAiFunction ${NS}><description>Does X</description><invocationTarget>${target}</invocationTarget>
      <invocationTargetType>${type}</invocationTargetType><isConfirmationRequired>false</isConfirmationRequired>
      <masterLabel>Do X</masterLabel></GenAiFunction>`;

  it("apex target joins the ApexClass node", async () => {
    const { nodes, edges } = await run("GenAiFunction", {
      name: "DoX",
      xml: fn("OrderSvc", "apex"),
    });
    expect(nodes[0]?.qualifiedName).toBe("GenAiFunction:DoX");
    expect(nodes[0]?.attributes).toMatchObject({
      description: "Does X",
      invocationTarget: "OrderSvc",
      invocationTargetType: "apex",
    });
    expect(edges).toEqual(["GenAiFunction:DoX -FUNCTION_INVOKES_APEX-> ApexClass:OrderSvc"]);
  });

  it("flow target", async () => {
    const { edges } = await run("GenAiFunction", { name: "DoX", xml: fn("Refund", "flow") });
    expect(edges).toEqual(["GenAiFunction:DoX -FUNCTION_INVOKES_FLOW-> Flow:Refund"]);
  });

  it.each(["prompt", "generatePromptResponse"])("%s target", async (t) => {
    const { edges } = await run("GenAiFunction", { name: "DoX", xml: fn("Summarize", t) });
    expect(edges).toEqual([
      "GenAiFunction:DoX -FUNCTION_USES_PROMPT-> GenAiPromptTemplate:Summarize",
    ]);
  });

  it("standardInvocableAction stays an attribute (no edge)", async () => {
    const { nodes, edges } = await run("GenAiFunction", {
      name: "DoX",
      xml: fn("streamingAction", "standardInvocableAction"),
    });
    expect(edges).toEqual([]);
    expect(nodes[0]?.attributes).toMatchObject({ invocationTargetType: "standardInvocableAction" });
  });

  it("missing fields: node only", async () => {
    const { nodes, edges } = await run("GenAiFunction", {
      name: "Bare",
      xml: `<GenAiFunction ${NS}/>`,
    });
    expect(nodes).toHaveLength(1);
    expect(edges).toEqual([]);
  });
});

describe("GenAiPromptTemplate", () => {
  const xml = `<?xml version="1.0"?><GenAiPromptTemplate ${NS}>
    <developerName>Acct_Summary</developerName><masterLabel>Acct Summary</masterLabel>
    <relatedEntity>Account</relatedEntity><type>einstein_gpt__recordSummary</type><visibility>Global</visibility>
    <templateVersions>
      <content>Summarize {!$Input:Account.Name} ({!$Input:Account.Tier__c}) and {!$RecordSnapshot:Account.Industry}.
        Repeat {!$Input:Account.Name}. Orders: {!$Flow:Load_Orders.Prompt}</content>
      <inputs><apiName>Account</apiName><definition>SOBJECT://Account</definition><referenceName>Input:Account</referenceName></inputs>
      <inputs><apiName>Contact</apiName><definition>SOBJECT://Contact</definition><referenceName>Input:Contact</referenceName></inputs>
      <primaryModel>sfdc_ai__DefaultGPT4Omni</primaryModel><status>Published</status>
      <templateDataProviders><definition>apex://OrderPromptProvider</definition><referenceName>Apex:OrderPromptProvider</referenceName></templateDataProviders>
      <templateDataProviders><definition>flow://Load_Orders</definition><referenceName>Flow:Load_Orders</referenceName></templateDataProviders>
    </templateVersions></GenAiPromptTemplate>`;

  it("grounds on objects, reads merge-field fields, calls data providers", async () => {
    const { nodes, edges } = await run("GenAiPromptTemplate", { name: "Acct_Summary", xml });
    expect(nodes[0]?.qualifiedName).toBe("GenAiPromptTemplate:Acct_Summary");
    expect(nodes[0]?.attributes).toMatchObject({
      templateType: "einstein_gpt__recordSummary",
      relatedEntity: "Account",
    });
    expect(edges).toEqual([
      "GenAiPromptTemplate:Acct_Summary -PROMPT_CALLS_APEX-> ApexClass:OrderPromptProvider",
      "GenAiPromptTemplate:Acct_Summary -PROMPT_CALLS_FLOW-> Flow:Load_Orders",
      "GenAiPromptTemplate:Acct_Summary -PROMPT_GROUNDS_ON_OBJECT-> CustomObject:Account",
      "GenAiPromptTemplate:Acct_Summary -PROMPT_GROUNDS_ON_OBJECT-> CustomObject:Contact",
      "GenAiPromptTemplate:Acct_Summary -PROMPT_READS_FIELD-> CustomField:Account.Industry",
      "GenAiPromptTemplate:Acct_Summary -PROMPT_READS_FIELD-> CustomField:Account.Name",
      "GenAiPromptTemplate:Acct_Summary -PROMPT_READS_FIELD-> CustomField:Account.Tier__c",
    ]);
  });

  it("handles several versions", async () => {
    const { edges } = await run("GenAiPromptTemplate", {
      name: "T",
      xml: `<GenAiPromptTemplate ${NS}>
        <templateVersions><content>{!$Input:Lead.Email}</content></templateVersions>
        <templateVersions><content>{!$Input:Lead.Phone}</content></templateVersions></GenAiPromptTemplate>`,
    });
    expect(edges).toEqual([
      "GenAiPromptTemplate:T -PROMPT_READS_FIELD-> CustomField:Lead.Email",
      "GenAiPromptTemplate:T -PROMPT_READS_FIELD-> CustomField:Lead.Phone",
    ]);
  });

  it("missing fields: node only", async () => {
    const { nodes, edges } = await run("GenAiPromptTemplate", {
      name: "Bare",
      xml: `<GenAiPromptTemplate ${NS}/>`,
    });
    expect(nodes).toHaveLength(1);
    expect(edges).toEqual([]);
  });
});

describe("Bot / BotVersion", () => {
  const version = `<BotVersion ${NS}><fullName>v1</fullName><status>Active</status><entryDialog>Welcome</entryDialog>
    <conversationDefinitionPlanners><genAiPlannerName>Svc</genAiPlannerName></conversationDefinitionPlanners>
    <botDialogs><developerName>Welcome</developerName>
      <botSteps><botInvocation><invocationActionName>Lookup_Flow</invocationActionName><invocationActionType>flow</invocationActionType></botInvocation><type>Invocation</type></botSteps>
      <botSteps><botInvocation><invocationActionName>OrderSvc</invocationActionName><invocationActionType>apex</invocationActionType></botInvocation><type>Invocation</type></botSteps>
      <botSteps><botInvocation><invocationActionName>Send</invocationActionName><invocationActionType>standardInvocableAction</invocationActionType></botInvocation><type>Invocation</type></botSteps>
    </botDialogs></BotVersion>`;

  it("BotVersion links its bot, planner and dialog invocations", async () => {
    const { nodes, edges } = await run("BotVersion", { name: "Support.v1", xml: version });
    expect(nodes[0]?.qualifiedName).toBe("BotVersion:Support.v1");
    expect(nodes[0]?.attributes).toMatchObject({ bot: "Support", status: "Active" });
    expect(edges).toEqual([
      "Bot:Support -BOT_HAS_VERSION-> BotVersion:Support.v1",
      "BotVersion:Support.v1 -BOT_INVOKES_APEX-> ApexClass:OrderSvc",
      "BotVersion:Support.v1 -BOT_INVOKES_FLOW-> Flow:Lookup_Flow",
      "BotVersion:Support.v1 -BOT_USES_PLANNER-> GenAiPlanner:Svc",
    ]);
  });

  it("BotVersion with no fields is just a node", async () => {
    const { nodes, edges } = await run("BotVersion", { name: "Odd", xml: `<BotVersion ${NS}/>` });
    expect(nodes).toHaveLength(1);
    expect(edges).toEqual([]);
  });

  it("Bot emits the node, planner and inline version", async () => {
    const { nodes, edges } = await run("Bot", {
      name: "Support",
      xml: `<Bot ${NS}><description>d</description><agentType>EinsteinServiceAgent</agentType>
        <botVersions><fullName>v1</fullName><conversationDefinitionPlanners><genAiPlannerName>Svc</genAiPlannerName></conversationDefinitionPlanners></botVersions></Bot>`,
    });
    expect(nodes[0]?.qualifiedName).toBe("Bot:Support");
    expect(edges).toEqual([
      "Bot:Support -BOT_HAS_VERSION-> BotVersion:Support.v1",
      "Bot:Support -BOT_USES_PLANNER-> GenAiPlanner:Svc",
    ]);
  });

  it("Bot with no fields is just a node", async () => {
    const { nodes, edges } = await run("Bot", { name: "Bare", xml: `<Bot ${NS}/>` });
    expect(nodes).toHaveLength(1);
    expect(edges).toEqual([]);
  });
});

describe("ExpressionSetDefinition / Version / DecisionMatrixDefinition", () => {
  it("ExpressionSetDefinition links matrices, Apex and objects", async () => {
    const { nodes, edges } = await run("ExpressionSetDefinition", {
      name: "Pricing_ES",
      xml: `<ExpressionSetDefinition ${NS}><usageType>CalculationsPricing</usageType><label>P</label>
        <versions><steps><decisionMatrixName>Tier_Matrix</decisionMatrixName></steps>
          <steps><apexClass>PriceHook</apexClass></steps>
          <objectAliases><objectApiName>Quote</objectApiName></objectAliases></versions></ExpressionSetDefinition>`,
    });
    expect(nodes[0]?.qualifiedName).toBe("ExpressionSetDefinition:Pricing_ES");
    expect(edges).toEqual([
      "ExpressionSetDefinition:Pricing_ES -EXPRESSION_SET_CALLS_APEX-> ApexClass:PriceHook",
      "ExpressionSetDefinition:Pricing_ES -EXPRESSION_SET_REFERENCES_OBJECT-> CustomObject:Quote",
      "ExpressionSetDefinition:Pricing_ES -EXPRESSION_SET_USES_MATRIX-> DecisionMatrixDefinition:Tier_Matrix",
    ]);
  });

  it("ExpressionSetDefinition with no references is just a node", async () => {
    const { nodes, edges } = await run("ExpressionSetDefinition", {
      name: "E",
      xml: `<ExpressionSetDefinition ${NS}/>`,
    });
    expect(nodes).toHaveLength(1);
    expect(edges).toEqual([]);
  });

  it("ExpressionSetDefinitionVersion hangs off its set", async () => {
    const { nodes, edges } = await run("ExpressionSetDefinitionVersion", {
      name: "Pricing_ES.v1",
      xml: `<ExpressionSetDefinitionVersion ${NS}><steps><decisionMatrixName>M</decisionMatrixName></steps></ExpressionSetDefinitionVersion>`,
    });
    expect(nodes[0]?.qualifiedName).toBe("ExpressionSetDefinitionVersion:Pricing_ES.v1");
    expect(edges).toEqual([
      "ExpressionSetDefinition:Pricing_ES -CONTAINS-> ExpressionSetDefinitionVersion:Pricing_ES.v1",
      "ExpressionSetDefinitionVersion:Pricing_ES.v1 -EXPRESSION_SET_USES_MATRIX-> DecisionMatrixDefinition:M",
    ]);
  });

  it("DecisionMatrixDefinition keeps its column names", async () => {
    const { nodes, edges } = await run("DecisionMatrixDefinition", {
      name: "Tier_Matrix",
      xml: `<DecisionMatrixDefinition ${NS}><decisionMatrixType>SingleOutput</decisionMatrixType>
        <columns><name>Tier</name><columnType>Input</columnType></columns>
        <columns><name>Rate</name><columnType>Output</columnType></columns></DecisionMatrixDefinition>`,
    });
    expect(nodes[0]?.qualifiedName).toBe("DecisionMatrixDefinition:Tier_Matrix");
    expect(nodes[0]?.attributes).toMatchObject({ columns: ["Tier", "Rate"] });
    expect(edges).toEqual([]);
  });

  it("DecisionMatrixDefinition without columns", async () => {
    const { nodes } = await run("DecisionMatrixDefinition", {
      name: "M",
      xml: `<DecisionMatrixDefinition ${NS}/>`,
    });
    expect(nodes[0]?.attributes).toMatchObject({ columns: [] });
  });
});

describe("Data Cloud", () => {
  it("DataStreamDefinition lands in its DLO", async () => {
    const { nodes, edges } = await run("DataStreamDefinition", {
      name: "Contacts_Stream",
      xml: `<DataStreamDefinition ${NS}><dataConnectorType>S3</dataConnectorType><dataSource>s3_prod</dataSource>
        <dataLakeObjectInfo><name>Contacts_Home</name><label>Contacts</label></dataLakeObjectInfo></DataStreamDefinition>`,
    });
    expect(nodes[0]?.qualifiedName).toBe("DataStreamDefinition:Contacts_Stream");
    expect(nodes[0]?.attributes).toMatchObject({ dataConnectorType: "S3", dataSource: "s3_prod" });
    expect(edges).toEqual([
      "DataStreamDefinition:Contacts_Stream -DATA_STREAM_FEEDS_OBJECT-> CustomObject:Contacts_Home__dll",
    ]);
  });

  it("DataStreamDefinition does not double the __dll suffix", async () => {
    const { edges } = await run("DataStreamDefinition", {
      name: "S",
      xml: `<DataStreamDefinition ${NS}><dataLakeObjectInfo><name>X__dll</name></dataLakeObjectInfo></DataStreamDefinition>`,
    });
    expect(edges).toEqual([
      "DataStreamDefinition:S -DATA_STREAM_FEEDS_OBJECT-> CustomObject:X__dll",
    ]);
  });

  it("DataStreamDefinition with no DLO is just a node", async () => {
    const { nodes, edges } = await run("DataStreamDefinition", {
      name: "S",
      xml: `<DataStreamDefinition ${NS}/>`,
    });
    expect(nodes).toHaveLength(1);
    expect(edges).toEqual([]);
  });

  it("ObjectSourceTargetMap maps the DLO to the DMO and field to field", async () => {
    const { nodes, edges } = await run("ObjectSourceTargetMap", {
      name: "Contacts_Home_Individual",
      xml: `<ObjectSourceTargetMap ${NS}><sourceObjectName>Contacts_Home__dll</sourceObjectName>
        <targetObjectName>Individual__dlm</targetObjectName>
        <fieldSourceTargetMaps><sourceField>first_name__c</sourceField><targetField>ssot__FirstName__c</targetField></fieldSourceTargetMaps>
        <fieldSourceTargetMaps><sourceField>id__c</sourceField><targetField>ssot__Id__c</targetField></fieldSourceTargetMaps>
      </ObjectSourceTargetMap>`,
    });
    expect(nodes[0]?.qualifiedName).toBe("ObjectSourceTargetMap:Contacts_Home_Individual");
    expect(edges).toEqual([
      "CustomField:Contacts_Home__dll.first_name__c -MAPS_TO_FIELD-> CustomField:Individual__dlm.ssot__FirstName__c",
      "CustomField:Contacts_Home__dll.id__c -MAPS_TO_FIELD-> CustomField:Individual__dlm.ssot__Id__c",
      "CustomObject:Contacts_Home__dll -MAPS_TO_OBJECT-> CustomObject:Individual__dlm",
    ]);
  });

  it("ObjectSourceTargetMap without field maps emits only the object edge; empty emits none", async () => {
    const one = await run("ObjectSourceTargetMap", {
      name: "M",
      xml: `<ObjectSourceTargetMap ${NS}><sourceObjectName>A__dll</sourceObjectName><targetObjectName>B__dlm</targetObjectName></ObjectSourceTargetMap>`,
    });
    expect(one.edges).toEqual(["CustomObject:A__dll -MAPS_TO_OBJECT-> CustomObject:B__dlm"]);
    const none = await run("ObjectSourceTargetMap", {
      name: "M",
      xml: `<ObjectSourceTargetMap ${NS}/>`,
    });
    expect(none.nodes).toHaveLength(1);
    expect(none.edges).toEqual([]);
  });

  it("MarketSegment is on its DMO (suffix added when the name is bare)", async () => {
    const full = await run("MarketSegment", {
      name: "VIPs",
      xml: `<MarketSegment ${NS}><segmentOn>UnifiedIndividual__dlm</segmentOn><dataSpace>default</dataSpace></MarketSegment>`,
    });
    expect(full.edges).toEqual([
      "MarketSegment:VIPs -SEGMENT_ON_OBJECT-> CustomObject:UnifiedIndividual__dlm",
    ]);
    const bare = await run("MarketSegment", {
      name: "VIPs",
      xml: `<MarketSegment ${NS}><segmentOn>Individual</segmentOn></MarketSegment>`,
    });
    expect(bare.edges).toEqual([
      "MarketSegment:VIPs -SEGMENT_ON_OBJECT-> CustomObject:Individual__dlm",
    ]);
  });

  it("MarketSegment with no segmentOn is just a node", async () => {
    const { nodes, edges } = await run("MarketSegment", {
      name: "S",
      xml: `<MarketSegment ${NS}/>`,
    });
    expect(nodes).toHaveLength(1);
    expect(edges).toEqual([]);
  });
});
