import { describe, expect, it } from "vitest";
import { makeTestCtx } from "../../__tests__/_harness.js";
import { FlowParser } from "../parser.js";

const flow = (body: string) =>
  `<?xml version="1.0" encoding="UTF-8"?><Flow xmlns="http://soap.sforce.com/2006/04/metadata"><apiVersion>59.0</apiVersion>${body}</Flow>`;

async function fieldEdges(body: string) {
  const r = await new FlowParser().parse(
    { fullName: "Sample_Flow", xml: flow(body) },
    makeTestCtx(),
  );
  return r.edges
    .filter((e) => e.relType === "READS_FIELD" || e.relType === "WRITES_FIELD")
    .map((e) => `${String(e.srcQualifiedName)} ${e.relType} ${String(e.dstQualifiedName)}`)
    .sort();
}

describe("Flow field references", () => {
  it("record-triggered: start filters, $Record refs and a $Record update", async () => {
    const edges = await fieldEdges(`
      <decisions><name>D</name><rules><conditions>
        <leftValueReference>$Record.Status__c</leftValueReference><operator>EqualTo</operator>
        <rightValue><elementReference>$Record__Prior.Status__c</elementReference></rightValue>
      </conditions></rules></decisions>
      <formulas><name>F</name><dataType>String</dataType><expression>{!$Record.Region__c} &amp; {!$Record.Account.Name}</expression></formulas>
      <recordUpdates><name>U</name>
        <inputAssignments><field>Initiator__c</field><value><elementReference>getUser.Name</elementReference></value></inputAssignments>
        <inputReference>$Record</inputReference>
      </recordUpdates>
      <recordLookups><name>getUser</name><object>User</object>
        <filters><field>Id</field><operator>EqualTo</operator><value><elementReference>$User.Id</elementReference></value></filters>
        <storeOutputAutomatically>true</storeOutputAutomatically>
      </recordLookups>
      <start><object>Order</object>
        <filters><field>Initiator__c</field><operator>IsNull</operator></filters>
        <recordTriggerType>CreateAndUpdate</recordTriggerType><triggerType>RecordBeforeSave</triggerType>
      </start>
    `);
    expect(edges).toEqual([
      "Flow:Sample_Flow READS_FIELD CustomField:Order.Initiator__c",
      "Flow:Sample_Flow READS_FIELD CustomField:Order.Region__c",
      "Flow:Sample_Flow READS_FIELD CustomField:Order.Status__c",
      "Flow:Sample_Flow READS_FIELD CustomField:User.Id",
      "Flow:Sample_Flow READS_FIELD CustomField:User.Name",
      "Flow:Sample_Flow WRITES_FIELD CustomField:Order.Initiator__c",
    ]);
  });

  it("process-builder variables, assignments, create/delete/lookup elements", async () => {
    const edges = await fieldEdges(`
      <variables><name>myVariable_current</name><dataType>SObject</dataType><isCollection>false</isCollection><objectType>Quote</objectType></variables>
      <variables><name>myVariable_old</name><dataType>SObject</dataType><isCollection>false</isCollection><objectType>Quote</objectType></variables>
      <variables><name>caseVar</name><dataType>SObject</dataType><objectType>Case</objectType></variables>
      <variables><name>plainText</name><dataType>String</dataType></variables>
      <decisions><name>D</name><rules><conditions>
        <leftValueReference>myVariable_current.Done__c</leftValueReference>
        <rightValue><elementReference>myVariable_old.Done__c</elementReference></rightValue>
      </conditions></rules></decisions>
      <assignments><name>A</name><assignmentItems>
        <assignToReference>caseVar.Subject</assignToReference><operator>Assign</operator>
        <value><elementReference>plainText</elementReference></value>
      </assignmentItems></assignments>
      <recordUpdates><name>U2</name><inputReference>caseVar</inputReference></recordUpdates>
      <recordCreates><name>C</name><object>Task</object>
        <inputAssignments><field>WhatId</field><value><elementReference>caseVar.Id</elementReference></value></inputAssignments>
      </recordCreates>
      <recordDeletes><name>Del</name><object>Note</object>
        <filters><field>ParentId</field><operator>EqualTo</operator></filters>
      </recordDeletes>
      <recordLookups><name>L</name><object>Account</object>
        <filters><field>Code__c</field><operator>EqualTo</operator></filters>
        <outputAssignments><assignToReference>plainText</assignToReference><field>Name</field></outputAssignments>
        <queriedFields>Rating</queriedFields>
        <sortField>CreatedDate</sortField>
      </recordLookups>
    `);
    expect(edges).toEqual([
      "Flow:Sample_Flow READS_FIELD CustomField:Account.Code__c",
      "Flow:Sample_Flow READS_FIELD CustomField:Account.CreatedDate",
      "Flow:Sample_Flow READS_FIELD CustomField:Account.Name",
      "Flow:Sample_Flow READS_FIELD CustomField:Account.Rating",
      "Flow:Sample_Flow READS_FIELD CustomField:Case.Id",
      "Flow:Sample_Flow READS_FIELD CustomField:Note.ParentId",
      "Flow:Sample_Flow READS_FIELD CustomField:Quote.Done__c",
      "Flow:Sample_Flow WRITES_FIELD CustomField:Case.Subject",
      "Flow:Sample_Flow WRITES_FIELD CustomField:Task.WhatId",
    ]);
  });

  it("assignments write a field only when the record is saved (or $Record before save)", async () => {
    const before = await fieldEdges(`
      <variables><name>memo</name><dataType>SObject</dataType><objectType>Case</objectType></variables>
      <variables><name>saved</name><dataType>SObject</dataType><objectType>Contact</objectType></variables>
      <assignments><name>A</name>
        <assignmentItems><assignToReference>$Record.Stage__c</assignToReference><operator>Assign</operator></assignmentItems>
        <assignmentItems><assignToReference>memo.Description</assignToReference><operator>Assign</operator></assignmentItems>
        <assignmentItems><assignToReference>saved.Title</assignToReference><operator>Assign</operator></assignmentItems>
      </assignments>
      <recordCreates><name>C</name><inputReference>saved</inputReference></recordCreates>
      <recordLookups><name>L</name><object>Account</object>
        <outputAssignments><assignToReference>saved.Department</assignToReference><field>Name</field></outputAssignments>
      </recordLookups>
      <start><object>Order</object><triggerType>RecordBeforeSave</triggerType></start>
    `);
    expect(before).toEqual([
      "Flow:Sample_Flow READS_FIELD CustomField:Account.Name",
      "Flow:Sample_Flow READS_FIELD CustomField:Case.Description",
      "Flow:Sample_Flow READS_FIELD CustomField:Contact.Department",
      "Flow:Sample_Flow WRITES_FIELD CustomField:Contact.Title",
      "Flow:Sample_Flow WRITES_FIELD CustomField:Order.Stage__c",
    ]);
    const after = await fieldEdges(`
      <assignments><name>A</name>
        <assignmentItems><assignToReference>$Record.Stage__c</assignToReference><operator>Assign</operator></assignmentItems>
      </assignments>
      <start><object>Order</object><triggerType>RecordAfterSave</triggerType></start>
    `);
    expect(after).toEqual(["Flow:Sample_Flow READS_FIELD CustomField:Order.Stage__c"]);
  });

  it("links screen extensions c:x to LWC, skipping other namespaces", async () => {
    const r = await new FlowParser().parse(
      {
        fullName: "Screen_Flow",
        xml: flow(`<screens><name>S</name>
          <fields><name>a</name><extensionName>c:accountPicker</extensionName><fieldType>ComponentInstance</fieldType></fields>
          <fields><name>b</name><extensionName>flowruntime:toggle</extensionName><fieldType>ComponentInstance</fieldType></fields>
          <fields><name>c</name><fields><name>d</name><extensionName>c:nestedPicker</extensionName></fields></fields>
        </screens>`),
      },
      makeTestCtx(),
    );
    expect(
      r.edges
        .filter((e) => e.relType === "EMBEDS_LWC")
        .map((e) => String(e.dstQualifiedName))
        .sort(),
    ).toEqual(["LWC:accountPicker", "LWC:nestedPicker"]);
  });
});
