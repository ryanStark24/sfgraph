import { asOrgId, asQualifiedName, asSha256 } from "@ryanstark24/sfgraph-shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { NodeFact } from "../../domain/index.js";
import { SqliteGraphStore } from "../../storage/sqlite/graph-store.js";
import {
  isStandardFieldQname,
  managedNamespaceCheck,
  managedNamespaces,
  namespaceOfApiName,
} from "../field-scope.js";
import { pseudoEndpointKind } from "../pseudo-endpoints.js";

const ORG = asOrgId("org_fs");
function node(label: string, qname: string): NodeFact {
  return {
    orgId: ORG,
    qualifiedName: asQualifiedName(qname),
    label,
    attributes: {},
    sourceHash: asSha256(qname),
    firstSeenAt: 1,
    lastSeenAt: 1,
    lastModifiedAt: 1,
  };
}

let store: SqliteGraphStore;
beforeEach(async () => {
  store = new SqliteGraphStore({ dbPath: ":memory:" });
  await store.init();
});
afterEach(async () => {
  await store.close();
});

describe("standard field grammar", () => {
  it("a field name without a custom suffix is standard", () => {
    expect(isStandardFieldQname("CustomField:Account.Name")).toBe(true);
    expect(isStandardFieldQname("CustomField:Obj__c.OwnerId")).toBe(true);
    expect(isStandardFieldQname("CustomField:Account.Tier__c")).toBe(false);
    expect(isStandardFieldQname("CustomField:Account.ns__Tier__c")).toBe(false);
    expect(isStandardFieldQname("CustomField:Account.Shoe__pc")).toBe(false);
    expect(isStandardFieldQname("CustomField:Obj__c.Loc__Latitude__s")).toBe(false);
    expect(isStandardFieldQname("CustomObject:Account")).toBe(false);
  });
});

describe("namespace prefix by API-name suffix grammar (fix M-1)", () => {
  it("ns__Name__<suffix> carries a namespace for every custom suffix", () => {
    for (const suffix of ["c", "r", "e", "mdt", "x", "b", "pc"]) {
      expect(namespaceOfApiName(`pkga__Thing__${suffix}`)).toBe("pkga");
      // No prefix: two parts.
      expect(namespaceOfApiName(`Thing__${suffix}`)).toBeNull();
    }
  });

  it("a compound sub-field (__s) has Field__Sub__s; only a fourth part is a namespace", () => {
    expect(namespaceOfApiName("Loc__Latitude__s")).toBeNull();
    expect(namespaceOfApiName("Loc__Longitude__s")).toBeNull();
    expect(namespaceOfApiName("pkga__Loc__Latitude__s")).toBe("pkga");
  });

  it("standard names, unknown suffixes and malformed parts have no namespace", () => {
    expect(namespaceOfApiName("Account")).toBeNull();
    expect(namespaceOfApiName("Name")).toBeNull();
    expect(namespaceOfApiName("pkga__Thing__zz")).toBeNull();
    expect(namespaceOfApiName("a__b__c__c")).toBeNull();
    expect(namespaceOfApiName("__Thing__c")).toBeNull();
    expect(namespaceOfApiName("9ns__Thing__c")).toBeNull();
  });

  it("a geolocation sub-field does not make its field name a managed namespace", () => {
    store.mergeNodes([
      node("CustomField", "CustomField:Site__c.Loc__Latitude__s"),
      node("CustomField", "CustomField:Site__c.Loc__c"),
    ]);
    expect([...managedNamespaces(store, ORG)]).toEqual([]);
  });
});

describe("managed-package namespaces from the org's own schema", () => {
  it("collects ns of ns__Name__c objects and fields, and refreshes on change", () => {
    store.mergeNodes([
      node("CustomObject", "CustomObject:Account"),
      node("CustomField", "CustomField:Account.Local__c"),
      node("CustomField", "CustomField:Account.pkga__Thing__c"),
    ]);
    expect([...managedNamespaces(store, ORG)]).toEqual(["pkga"]);
    store.mergeNodes([node("CustomObject", "CustomObject:PkgB__Order__c")]);
    expect([...managedNamespaces(store, ORG)].sort()).toEqual(["pkga", "pkgb"]);
  });

  it("an ns.Type target with no node is managed-package; a real class or unknown head is not", () => {
    store.mergeNodes([node("CustomField", "CustomField:Account.pkga__Thing__c")]);
    const isManagedNamespace = managedNamespaceCheck(store, ORG);
    const none = new Set<string>();
    expect(
      pseudoEndpointKind("ApexClass:pkga.OpenInterface", false, none, { isManagedNamespace }),
    ).toBe("managed-package");
    expect(
      pseudoEndpointKind("ApexMethod:PKGA.Svc.run(1)", false, none, { isManagedNamespace }),
    ).toBe("managed-package");
    // A node row, an unknown namespace, a bare name or a same-name class: a component.
    expect(
      pseudoEndpointKind("ApexClass:pkga.OpenInterface", true, none, { isManagedNamespace }),
    ).toBeNull();
    expect(
      pseudoEndpointKind("ApexClass:other.OpenInterface", false, none, { isManagedNamespace }),
    ).toBeNull();
    expect(pseudoEndpointKind("ApexClass:pkga", false, none, { isManagedNamespace })).toBeNull();
    expect(
      pseudoEndpointKind("ApexClass:pkga.OpenInterface", false, none, {
        isManagedNamespace,
        hasClass: (n) => n === "pkga",
      }),
    ).toBeNull();
    // Without the option nothing changes.
    expect(pseudoEndpointKind("ApexClass:pkga.OpenInterface", false, none)).toBeNull();
  });
});
