import { describe, expect, it } from "vitest";
import { makeTestCtx } from "../../__tests__/_harness.js";
import { FlowParser } from "../parser.js";

const flow = (body: string) =>
  `<?xml version="1.0" encoding="UTF-8"?><Flow xmlns="http://soap.sforce.com/2006/04/metadata"><apiVersion>59.0</apiVersion>${body}</Flow>`;

async function parse(body: string) {
  return new FlowParser().parse({ fullName: "Sample_Flow", xml: flow(body) }, makeTestCtx());
}

async function edgesOf(body: string, rels: string[]) {
  const r = await parse(body);
  return r.edges
    .filter((e) => rels.includes(e.relType))
    .map((e) => `${String(e.srcQualifiedName)} ${e.relType} ${String(e.dstQualifiedName)}`)
    .sort();
}

const fieldEdges = (body: string) => edgesOf(body, ["READS_FIELD", "WRITES_FIELD"]);

async function relPaths(body: string) {
  const r = await parse(body);
  const flowNode = r.nodes.find((n) => n.label === "Flow");
  return (flowNode?.attributes.flowRelationshipPaths ?? []) as Array<{
    object: string;
    path: string;
    rel: string;
  }>;
}

describe("Flow bulk-update pattern (loop, assign, add, save collection)", () => {
  it("writes the loop variable's assigned fields when its output collection is saved", async () => {
    const edges = await fieldEdges(`
      <variables><name>accs</name><dataType>SObject</dataType><isCollection>true</isCollection><objectType>Account</objectType></variables>
      <variables><name>toUpdate</name><dataType>SObject</dataType><isCollection>true</isCollection><objectType>Account</objectType></variables>
      <loops><name>EachAcc</name><collectionReference>accs</collectionReference><iterationOrder>Asc</iterationOrder></loops>
      <assignments><name>SetTier</name>
        <assignmentItems><assignToReference>EachAcc.Tier__c</assignToReference><operator>Assign</operator><value><stringValue>Gold</stringValue></value></assignmentItems>
        <assignmentItems><assignToReference>toUpdate</assignToReference><operator>Add</operator><value><elementReference>EachAcc</elementReference></value></assignmentItems>
      </assignments>
      <recordUpdates><name>Save</name><inputReference>toUpdate</inputReference></recordUpdates>
    `);
    expect(edges).toEqual(["Flow:Sample_Flow WRITES_FIELD CustomField:Account.Tier__c"]);
  });

  it("types collections from Get Records outputReference and old-style loop variables", async () => {
    const edges = await fieldEdges(`
      <variables><name>cons</name><dataType>SObject</dataType><isCollection>true</isCollection></variables>
      <variables><name>con</name><dataType>SObject</dataType></variables>
      <variables><name>out</name><dataType>SObject</dataType><isCollection>true</isCollection></variables>
      <recordLookups><name>getCons</name><object>Contact</object><outputReference>cons</outputReference></recordLookups>
      <loops><name>L</name><collectionReference>cons</collectionReference><assignNextValueToReference>con</assignNextValueToReference></loops>
      <assignments><name>A</name>
        <assignmentItems><assignToReference>con.Email</assignToReference><operator>Assign</operator></assignmentItems>
        <assignmentItems><assignToReference>out</assignToReference><operator>AddAtStart</operator><value><elementReference>con</elementReference></value></assignmentItems>
      </assignments>
      <recordCreates><name>C</name><inputReference>out</inputReference></recordCreates>
    `);
    expect(edges).toEqual(["Flow:Sample_Flow WRITES_FIELD CustomField:Contact.Email"]);
  });

  it("types the loop over a Get Records element that stores its output automatically", async () => {
    const edges = await fieldEdges(`
      <variables><name>outList</name><dataType>SObject</dataType><isCollection>true</isCollection><objectType>Case</objectType></variables>
      <recordLookups><name>getCases</name><object>Case</object><storeOutputAutomatically>true</storeOutputAutomatically></recordLookups>
      <loops><name>EachCase</name><collectionReference>getCases</collectionReference></loops>
      <assignments><name>A</name>
        <assignmentItems><assignToReference>EachCase.Priority</assignToReference><operator>Assign</operator></assignmentItems>
        <assignmentItems><assignToReference>outList</assignToReference><operator>Add</operator><value><elementReference>EachCase</elementReference></value></assignmentItems>
      </assignments>
      <recordUpdates><name>U</name><inputReference>outList</inputReference></recordUpdates>
    `);
    expect(edges).toEqual(["Flow:Sample_Flow WRITES_FIELD CustomField:Case.Priority"]);
  });

  it("negative: an unsaved output collection, or a different record added, stays a read", async () => {
    const edges = await fieldEdges(`
      <variables><name>accs</name><dataType>SObject</dataType><isCollection>true</isCollection><objectType>Account</objectType></variables>
      <variables><name>kept</name><dataType>SObject</dataType><isCollection>true</isCollection><objectType>Account</objectType></variables>
      <variables><name>saved</name><dataType>SObject</dataType><isCollection>true</isCollection><objectType>Account</objectType></variables>
      <variables><name>other</name><dataType>SObject</dataType><objectType>Account</objectType></variables>
      <loops><name>EachAcc</name><collectionReference>accs</collectionReference></loops>
      <assignments><name>A</name>
        <assignmentItems><assignToReference>EachAcc.Tier__c</assignToReference><operator>Assign</operator></assignmentItems>
        <assignmentItems><assignToReference>kept</assignToReference><operator>Add</operator><value><elementReference>EachAcc</elementReference></value></assignmentItems>
        <assignmentItems><assignToReference>saved</assignToReference><operator>Add</operator><value><elementReference>other</elementReference></value></assignmentItems>
      </assignments>
      <recordUpdates><name>U</name><inputReference>saved</inputReference></recordUpdates>
    `);
    expect(edges).toEqual(["Flow:Sample_Flow READS_FIELD CustomField:Account.Tier__c"]);
  });
});

describe("Flow multi-hop relationship paths", () => {
  it("records relationship paths from formulas, conditions, assignments and text templates", async () => {
    const body = `
      <variables><name>memo</name><dataType>String</dataType></variables>
      <recordLookups><name>getOpp</name><object>Opportunity</object><storeOutputAutomatically>true</storeOutputAutomatically></recordLookups>
      <formulas><name>F</name><dataType>String</dataType><expression>{!$Record.Account.Region__c} &amp; {!$Record.Status__c}</expression></formulas>
      <decisions><name>D</name><rules><conditions>
        <leftValueReference>$Record.Owner.Email</leftValueReference><operator>EqualTo</operator>
      </conditions></rules></decisions>
      <assignments><name>A</name><assignmentItems>
        <assignToReference>memo</assignToReference><operator>Assign</operator>
        <value><elementReference>$Record.Parent__r.Area__r.Code__c</elementReference></value>
      </assignmentItems></assignments>
      <textTemplates><name>T</name><text>Owner: {!getOpp.Account.Owner.Name}</text></textTemplates>
      <start><object>Order</object><triggerType>RecordAfterSave</triggerType></start>
    `;
    expect(await relPaths(body)).toEqual(
      expect.arrayContaining([
        { object: "Order", path: "Account.Region__c", rel: "READS_FIELD" },
        { object: "Order", path: "Owner.Email", rel: "READS_FIELD" },
        { object: "Order", path: "Parent__r.Area__r.Code__c", rel: "READS_FIELD" },
        { object: "Opportunity", path: "Account.Owner.Name", rel: "READS_FIELD" },
      ]),
    );
    expect(await relPaths(body)).toHaveLength(4);
    // Direct one-hop reads are unchanged; the paths emit nothing at parse time.
    expect(await fieldEdges(body)).toEqual([
      "Flow:Sample_Flow READS_FIELD CustomField:Order.Status__c",
    ]);
  });

  it("a trailing `X__r` is a relationship, recorded as a path (not a field named X__r)", async () => {
    const body = `
      <variables><name>rec</name><dataType>SObject</dataType><objectType>Case</objectType></variables>
      <variables><name>memo</name><dataType>SObject</dataType><objectType>Account</objectType></variables>
      <assignments><name>A</name><assignmentItems>
        <assignToReference>memo</assignToReference><operator>Assign</operator>
        <value><elementReference>rec.Site__r</elementReference></value>
      </assignmentItems></assignments>
    `;
    expect(await fieldEdges(body)).toEqual([]);
    expect(await relPaths(body)).toEqual([{ object: "Case", path: "Site__r", rel: "READS_FIELD" }]);
  });

  it("negative: no path for unknown variables or system globals", async () => {
    const body = `
      <formulas><name>F</name><dataType>String</dataType><expression>{!$User.Profile.Name} &amp; {!unknownVar.Account.Name} &amp; {!$Flow.CurrentDate}</expression></formulas>
    `;
    expect(await relPaths(body)).toEqual([]);
    expect(await fieldEdges(body)).toEqual([]);
  });
});

describe("Flow inputReference to a record / relationship", () => {
  it("a related-record inputReference is no field read; its assignments are a path write", async () => {
    const body = `
      <recordUpdates><name>U</name>
        <inputAssignments><field>Region__c</field><value><stringValue>EMEA</stringValue></value></inputAssignments>
        <inputReference>$Record.Account</inputReference>
      </recordUpdates>
      <start><object>Order</object><triggerType>RecordAfterSave</triggerType></start>
    `;
    expect(await fieldEdges(body)).toEqual([]);
    expect(await relPaths(body)).toEqual([
      { object: "Order", path: "Account.Region__c", rel: "WRITES_FIELD" },
    ]);
  });

  it("a record variable or custom relationship inputReference is no field read", async () => {
    const edges = await fieldEdges(`
      <variables><name>rec</name><dataType>SObject</dataType><objectType>Case</objectType></variables>
      <recordUpdates><name>U1</name><inputReference>rec</inputReference></recordUpdates>
      <recordUpdates><name>U2</name><inputReference>rec.Site__r</inputReference></recordUpdates>
      <recordDeletes><name>D1</name><inputReference>rec.Contact</inputReference></recordDeletes>
    `);
    expect(edges).toEqual([]);
  });

  it("negative: element field references next to the inputReference are still emitted", async () => {
    const edges = await fieldEdges(`
      <variables><name>rec</name><dataType>SObject</dataType><objectType>Case</objectType></variables>
      <recordUpdates><name>U</name>
        <inputAssignments><field>Status</field><value><elementReference>rec.Origin</elementReference></value></inputAssignments>
        <inputReference>rec</inputReference>
      </recordUpdates>
    `);
    expect(edges).toEqual([
      "Flow:Sample_Flow READS_FIELD CustomField:Case.Origin",
      "Flow:Sample_Flow WRITES_FIELD CustomField:Case.Status",
    ]);
  });
});

describe("Flow platform events", () => {
  const EVENTS = ["PUBLISHES_EVENT", "SUBSCRIBES_TO_EVENT"];

  it("Create Records on a __e object (by object or by record variable) publishes the event", async () => {
    const edges = await edgesOf(
      `
      <variables><name>evt</name><dataType>SObject</dataType><objectType>Audit_Event__e</objectType></variables>
      <recordCreates><name>Pub1</name><object>Order_Event__e</object>
        <inputAssignments><field>Order_Id__c</field><value><elementReference>$Record.Id</elementReference></value></inputAssignments>
      </recordCreates>
      <recordCreates><name>Pub2</name><inputReference>evt</inputReference></recordCreates>
    `,
      EVENTS,
    );
    expect(edges).toEqual([
      "Flow:Sample_Flow PUBLISHES_EVENT PlatformEvent:Audit_Event__e",
      "Flow:Sample_Flow PUBLISHES_EVENT PlatformEvent:Order_Event__e",
    ]);
  });

  it("a platform-event-triggered flow subscribes to its event", async () => {
    const edges = await edgesOf(
      "<start><object>Order_Event__e</object><triggerType>PlatformEvent</triggerType></start>",
      EVENTS,
    );
    expect(edges).toEqual(["Flow:Sample_Flow SUBSCRIBES_TO_EVENT PlatformEvent:Order_Event__e"]);
  });

  it("negative: ordinary creates and record-triggered starts emit no event edges", async () => {
    const edges = await edgesOf(
      `
      <variables><name>acc</name><dataType>SObject</dataType><objectType>Account</objectType></variables>
      <recordCreates><name>C1</name><object>Task</object></recordCreates>
      <recordCreates><name>C2</name><inputReference>acc</inputReference></recordCreates>
      <recordUpdates><name>U</name><object>Order_Event__e</object></recordUpdates>
      <start><object>Order</object><triggerType>RecordAfterSave</triggerType></start>
    `,
      EVENTS,
    );
    expect(edges).toEqual([]);
  });
});
