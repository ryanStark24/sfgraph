import type { OrgId, QualifiedName, Sha256 } from "@ryanstark24/sfgraph-shared";
import { describe, expect, it } from "vitest";
import type { NodeFact } from "../../domain/index.js";
import { hideOneSided, isManagedItem, isStandardItem } from "../cross-org.js";

const node = (qn: string, attributes: Record<string, unknown> = {}): NodeFact => ({
  orgId: "o" as OrgId,
  qualifiedName: qn as QualifiedName,
  label: qn.slice(0, qn.indexOf(":")),
  attributes,
  sourceHash: "h" as Sha256,
  firstSeenAt: 0,
  lastSeenAt: 0,
  lastModifiedAt: 0,
});

describe("cross-org: managed and standard items", () => {
  it("a namespace prefix on the item's own name marks it managed; a custom suffix alone does not", () => {
    expect(isManagedItem(node("CustomObject:acme__Invoice__c"))).toBe(true);
    expect(isManagedItem(node("CustomObject:acme__Rate__mdt"))).toBe(true);
    expect(isManagedItem(node("CustomField:Account.acme__Tier__c"))).toBe(true);
    expect(isManagedItem(node("CustomObject:Invoice__c"))).toBe(false);
    expect(isManagedItem(node("CustomObject:Account"))).toBe(false);
    // a local item on a managed object is the org's own work
    expect(isManagedItem(node("CustomField:acme__Invoice__c.Local_Note__c"))).toBe(false);
    expect(isManagedItem(node("WorkflowAlert:acme__Invoice__c.Notify_Owner"))).toBe(false);
  });

  it("follows the API-name grammar: person-account, compound, change-event and data-lake names are local", () => {
    expect(isManagedItem(node("CustomField:Account.Foo__pc"))).toBe(false);
    expect(isManagedItem(node("CustomField:Account.Loc__Latitude__s"))).toBe(false);
    expect(isManagedItem(node("CustomObject:Invoice__ChangeEvent"))).toBe(false);
    expect(isManagedItem(node("CustomObject:Sales__dlm"))).toBe(false);
    expect(isManagedItem(node("CustomField:Account.acme__Foo__pc"))).toBe(true);
    expect(isManagedItem(node("CustomField:Account.acme__Loc__Latitude__s"))).toBe(true);
  });

  it("Apex whose code the org does not show (the empty-body stub) is managed; parsed or failed Apex is not", () => {
    expect(isManagedItem(node("ApexClass:Widget", { modifiers: [], isTest: false }))).toBe(true);
    expect(isManagedItem(node("ApexClass:Widget", { modifiers: [], bodyUnavailable: true }))).toBe(
      true,
    );
    // a parsed local enum carries its modifiers
    expect(isManagedItem(node("ApexClass:Color", { modifiers: ["public"], isTest: false }))).toBe(
      false,
    );
    expect(isManagedItem(node("ApexClass:Widget", { modifiers: ["public"] }))).toBe(false);
    expect(isManagedItem(node("ApexClass:Widget", { modifiers: [], parseFailed: true }))).toBe(
      false,
    );
    expect(isManagedItem(node("ApexTrigger:WidgetTrigger", { object: null, events: [] }))).toBe(
      true,
    );
    expect(
      isManagedItem(
        node("ApexTrigger:WidgetTrigger", { object: "Widget__c", events: ["after insert"] }),
      ),
    ).toBe(false);
  });

  it("standard objects and fields have no custom suffix", () => {
    expect(isStandardItem(node("CustomObject:Account"))).toBe(true);
    expect(isStandardItem(node("CustomField:Account.Industry"))).toBe(true);
    expect(isStandardItem(node("CustomObject:Invoice__c"))).toBe(false);
    expect(isStandardItem(node("CustomField:Account.Tier__c"))).toBe(false);
    expect(isStandardItem(node("ApexClass:Account"))).toBe(false);
  });

  it("hideOneSided drops managed and standard items found in one org only, keeps changed ones, and counts them", () => {
    const diff = {
      onlyInA: [node("CustomObject:Activity"), node("CustomObject:Invoice__c")],
      onlyInB: [
        node("CustomObject:acme__Rate__mdt"),
        node("CustomObject:AccountBrand"),
        node("ApexClass:Widget", { modifiers: [] }),
        node("ApexClass:Local", { modifiers: ["public"] }),
      ],
      changed: [
        { a: node("CustomObject:Account"), b: node("CustomObject:Account") },
        { a: node("CustomObject:acme__Doc__c"), b: node("CustomObject:acme__Doc__c") },
      ],
    };
    const out = hideOneSided(diff, { includeManaged: false, includeStandard: false });
    expect(out.onlyInA.map((n) => n.qualifiedName)).toEqual(["CustomObject:Invoice__c"]);
    expect(out.onlyInB.map((n) => n.qualifiedName)).toEqual(["ApexClass:Local"]);
    expect(out.changed).toHaveLength(2);
    expect(out.hidden).toEqual({ managed: 2, standard: 2 });

    const all = hideOneSided(diff, { includeManaged: true, includeStandard: true });
    expect(all.onlyInA).toHaveLength(2);
    expect(all.onlyInB).toHaveLength(4);
    expect(all.hidden).toEqual({ managed: 0, standard: 0 });

    const onlyStd = hideOneSided(diff, { includeManaged: true, includeStandard: false });
    expect(onlyStd.hidden).toEqual({ managed: 0, standard: 2 });
  });
});
