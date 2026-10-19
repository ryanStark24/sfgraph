import type { OrgId } from "@ryanstark24/sfgraph-shared";
import type { GraphStore } from "../storage/interfaces.js";

/**
 * Field and namespace grammar for the dependency answers (Batch R / S2).
 *
 * Salesforce API names carry their kind in a suffix: a custom field ends in
 * `__c` (`__pc` on person accounts, `__s` for a compound sub-field), a
 * managed-package member also carries its namespace prefix (`ns__Name__c`).
 * A field name with no `__<suffix>` is a standard field (`Account.Name`).
 */

const SUFFIXED = /__[A-Za-z0-9]+$/;

/** The field part of a `CustomField:Object.Field` qname (after the last dot). */
function fieldPart(qname: string): string {
  const name = qname.slice(qname.indexOf(":") + 1);
  return name.slice(name.lastIndexOf(".") + 1);
}

/**
 * True for a CustomField qname whose field name has no custom `__<suffix>`
 * (`CustomField:Account.Name`, `CustomField:Case.OwnerId`): a standard field.
 * False for every other label and for custom fields (`Account.X__c`).
 */
export function isStandardFieldQname(qname: string): boolean {
  if (!qname.startsWith("CustomField:")) return false;
  const f = fieldPart(qname);
  return f.length > 0 && !SUFFIXED.test(f);
}

/** Custom API-name suffixes after which a third `__` part is a namespace
 *  (`ns__Name__c`): fields/objects, relationships, platform events, custom
 *  metadata types, external and big objects, person-account fields. */
const NAMESPACED_SUFFIXES: ReadonlySet<string> = new Set(["c", "r", "e", "mdt", "x", "b", "pc"]);
/** A compound-field sub-field is `Field__Sub__s` (`Loc__Latitude__s`), so a
 *  namespace is a fourth part (`ns__Loc__Latitude__s`). */
const SUBFIELD_SUFFIX = "s";
const NS_GRAMMAR = /^[A-Za-z][A-Za-z0-9_]*$/;

/**
 * The namespace prefix of one API-name part, by the suffix grammar:
 * `ns__Name__c` (any NAMESPACED_SUFFIXES suffix) and `ns__Field__Sub__s`
 * -> `ns`. `Name__c`, `Loc__Latitude__s`, standard names, unknown suffixes
 * and malformed parts -> null.
 */
export function namespaceOfApiName(part: string): string | null {
  const bits = part.split("__");
  const suffix = bits[bits.length - 1] ?? "";
  const want = NAMESPACED_SUFFIXES.has(suffix) ? 3 : suffix === SUBFIELD_SUFFIX ? 4 : 0;
  if (want === 0 || bits.length !== want) return null;
  if (bits.some((b) => b.length === 0)) return null;
  const ns = bits[0] as string;
  return NS_GRAMMAR.test(ns) ? ns : null;
}

type NsCacheEntry = { key: string; set: ReadonlySet<string> };
const nsCache = new WeakMap<GraphStore, Map<string, NsCacheEntry>>();

/**
 * The managed-package namespaces the org's own schema shows, lower-cased:
 * every `ns` of an object or field API name shaped `ns__Name__c` (any
 * namespaced custom suffix, `namespaceOfApiName`). Read from the graph, never from a fixed list. Cached per store and
 * org until the sync generation or the object/field counts change.
 */
export function managedNamespaces(store: GraphStore, orgId: OrgId): ReadonlySet<string> {
  let gen = 0;
  try {
    gen = store.getSyncStatus(orgId).generation;
  } catch {
    gen = -1;
  }
  const key = `${gen}:${store.countNodesByLabel(orgId, "CustomObject")}:${store.countNodesByLabel(orgId, "CustomField")}`;
  let byOrg = nsCache.get(store);
  if (!byOrg) {
    byOrg = new Map();
    nsCache.set(store, byOrg);
  }
  const hit = byOrg.get(String(orgId));
  if (hit && hit.key === key) return hit.set;
  const set = new Set<string>();
  for (const label of ["CustomObject", "CustomField"]) {
    for (const n of store.listNodesByLabel(orgId, label)) {
      const q = String(n.qualifiedName);
      for (const part of q.slice(q.indexOf(":") + 1).split(".")) {
        const ns = namespaceOfApiName(part);
        if (ns) set.add(ns.toLowerCase());
      }
    }
  }
  byOrg.set(String(orgId), { key, set });
  return set;
}

/** `managedNamespaces` as the `isManagedNamespace` pseudo-endpoint option. */
export function managedNamespaceCheck(store: GraphStore, orgId: OrgId): (ns: string) => boolean {
  const set = managedNamespaces(store, orgId);
  return (ns) => set.has(ns.toLowerCase());
}
