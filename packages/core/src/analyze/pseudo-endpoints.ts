import type { OrgId } from "@ryanstark24/sfgraph-shared";
import { asQualifiedName } from "@ryanstark24/sfgraph-shared";
import type { GraphStore } from "../storage/interfaces.js";
import { isApexPlatformQname } from "./apex-platform.js";
import { labelOfQname } from "./edge-filters.js";

/**
 * Pseudo endpoints: edge targets that are not org components a dependency
 * answer should list. The traces and the flow map move them to a separate
 * `pseudo` list instead of dropping them, so nothing is lost:
 *
 *  - `apex-platform`: Apex platform classes and calls into them
 *    (`ApexMethod:Database.query(1)`, `ApexClass:System`) with no node row;
 *  - `dml`: `DML:insert` / `DML:update` operation markers;
 *  - `lwc-property` / `lwc-event`: LWC template bindings and DOM events;
 *  - `remote-duplicate`: `Remote:X` (a Vlocity remote-class call) when
 *    `ApexClass:X` itself is in the same answer;
 *  - `managed-package`: a `ns.Type` target with no node row whose head `ns`
 *    is a managed-package namespace of the org (`managedNamespaces`: the
 *    `ns__Name__c` prefixes of its own objects and fields), e.g. a class
 *    implementing a packaged interface. Its source is not in the org.
 */
export type PseudoKind =
  | "apex-platform"
  | "dml"
  | "lwc-property"
  | "lwc-event"
  | "remote-duplicate"
  | "managed-package";

const LABEL_KIND: Readonly<Record<string, PseudoKind>> = {
  DML: "dml",
  LWCProperty: "lwc-property",
  LWCEvent: "lwc-event",
};

export interface PseudoEndpointOpts {
  /** True when the org has a real class of this name (`ApexClass:<name>`
   *  node). A dangling `ApexMethod:Security.check(2)` on a user class named
   *  `Security` is then a component, not platform Apex. */
  hasClass?: (className: string) => boolean;
  /** Qnames present in the answer but not in `rows` (a trace root, the flow
   *  map entry), for the Remote/ApexClass duplicate rule. */
  alsoPresent?: Iterable<string>;
  /** True when `ns` is a managed-package namespace of the org
   *  (`managedNamespaceCheck`). Without it no `managed-package` kind is
   *  assigned. */
  isManagedNamespace?: (ns: string) => boolean;
}

/**
 * The `hasClass` check every pseudo-endpoint caller uses: the org has a real
 * Apex type of this name, an `ApexClass:<name>` or an `ApexInterface:<name>`
 * node. getNode compares qnames without case (the qname columns are COLLATE
 * NOCASE), so `ApexInterface:callable` matches a `Callable.call(2)` call.
 */
export function apexTypeExists(store: GraphStore, orgId: OrgId): (name: string) => boolean {
  return (name) =>
    store.getNode(orgId, asQualifiedName(`ApexClass:${name}`)) !== null ||
    store.getNode(orgId, asQualifiedName(`ApexInterface:${name}`)) !== null;
}

/** Code-point string order (not locale order), for deterministic lists. */
export function codePointCompare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** The one pseudo-list order: by kind, then qname, both by code point. */
export function comparePseudo(
  a: { pseudoKind: string; qname: string },
  b: { pseudoKind: string; qname: string },
): number {
  return codePointCompare(a.pseudoKind, b.pseudoKind) || codePointCompare(a.qname, b.qname);
}

const headOf = (qname: string): string => {
  const name = qname.slice(qname.indexOf(":") + 1);
  return name.split(/[.(]/, 1)[0] ?? name;
};

/**
 * The pseudo kind of `qname`, or null when it is a real component.
 * `reachedLower` holds the lower-cased qnames of the whole answer (for the
 * Remote/ApexClass duplicate rule).
 */
export function pseudoEndpointKind(
  qname: string,
  hasNode: boolean,
  reachedLower: ReadonlySet<string>,
  opts: PseudoEndpointOpts = {},
): PseudoKind | null {
  const label = labelOfQname(qname);
  const byLabel = LABEL_KIND[label];
  if (byLabel) return byLabel;
  if (!hasNode && isApexPlatformQname(qname) && !opts.hasClass?.(headOf(qname))) {
    return "apex-platform";
  }
  if (!hasNode && opts.isManagedNamespace && label !== "CustomField" && label !== "CustomObject") {
    const name = qname.slice(qname.indexOf(":") + 1);
    const head = headOf(qname);
    if (
      name.charAt(head.length) === "." &&
      opts.isManagedNamespace(head) &&
      !opts.hasClass?.(head)
    ) {
      return "managed-package";
    }
  }
  if (label === "Remote") {
    const name = qname.slice(qname.indexOf(":") + 1);
    if (reachedLower.has(`apexclass:${name}`.toLowerCase())) return "remote-duplicate";
  }
  return null;
}

/** Split rows into real components (order kept) and pseudo endpoints (sorted
 *  by kind, then qname). */
export function partitionPseudoEndpoints<T extends { qualifiedName: string; hasNode?: boolean }>(
  rows: readonly T[],
  opts: PseudoEndpointOpts = {},
): { kept: T[]; pseudo: Array<T & { pseudoKind: PseudoKind }> } {
  const lower = new Set(rows.map((r) => r.qualifiedName.toLowerCase()));
  for (const q of opts.alsoPresent ?? []) lower.add(q.toLowerCase());
  const kept: T[] = [];
  const pseudo: Array<T & { pseudoKind: PseudoKind }> = [];
  for (const r of rows) {
    const kind = pseudoEndpointKind(r.qualifiedName, r.hasNode !== false, lower, opts);
    if (kind) pseudo.push({ ...r, pseudoKind: kind });
    else kept.push(r);
  }
  pseudo.sort((x, y) =>
    comparePseudo(
      { pseudoKind: x.pseudoKind, qname: x.qualifiedName },
      { pseudoKind: y.pseudoKind, qname: y.qualifiedName },
    ),
  );
  return { kept, pseudo };
}
