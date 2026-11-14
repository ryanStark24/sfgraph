import type { OrgId } from "@ryanstark24/sfgraph-shared";
import type { NodeFact } from "../../domain/index.js";
import { nameKey } from "../../domain/name-key.js";
import type { GraphStore } from "../../storage/interfaces.js";
import { ownerOf } from "../containment.js";
import { type HiddenCounts, diffOrgs, hideOneSided } from "../cross-org.js";
import { formatMemberName } from "./member-name-formatters.js";
import { metadataTypeFor } from "./member-types.js";

export interface DeploymentManifest {
  packageXml: string;
  destructiveXml: string;
  summary: {
    apiVersion: string;
    addedOrChanged: number;
    removed: number;
    byType: Record<string, number>;
  };
  /**
   * The package.xml is INCOMPLETE when this is set — surfaced so the caller
   * never treats a partial manifest as the full change set.
   *  - `diffTruncated`: the cross-org diff hit its per-label cap, so some
   *    changed members were never considered.
   *  - `unmappedLabels`: changed nodes whose label has no Metadata API type
   *    mapping (or no formattable member name); they were dropped from the XML.
   */
  incomplete: {
    diffTruncated: boolean;
    unmappedLabels: Record<string, number>;
  };
  /**
   * Managed-package and standard items present in one org only, left out of both
   * files (see {@link hideOneSided}). Such an item reflects what each org installed or
   * retrieved, not a change; in destructiveChanges.xml it would delete a package's or
   * Salesforce's own component from the target.
   */
  hidden: HiddenCounts;
  /**
   * Members left out of destructiveChanges.xml because the same component (same type, same
   * name without case) is in package.xml. A component is never both deployed and deleted.
   * Normally empty; a non-empty list is reported so the caller can see what was dropped.
   */
  droppedFromDestructive: Array<{ type: string; member: string }>;
}

function escapeXml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function buildPackage(members: Map<string, Set<string>>, apiVersion: string): string {
  const lines = ['<?xml version="1.0" encoding="UTF-8"?>'];
  lines.push('<Package xmlns="http://soap.sforce.com/2006/04/metadata">');
  const types = Array.from(members.keys()).sort();
  for (const t of types) {
    const set = members.get(t);
    if (!set || set.size === 0) continue;
    lines.push("  <types>");
    for (const m of Array.from(set).sort()) {
      lines.push(`    <members>${escapeXml(m)}</members>`);
    }
    lines.push(`    <name>${t}</name>`);
    lines.push("  </types>");
  }
  lines.push(`  <version>${escapeXml(apiVersion)}</version>`);
  lines.push("</Package>");
  return `${lines.join("\n")}\n`;
}

export interface GenerateManifestArgs {
  storeA: GraphStore;
  orgA: OrgId; // source (has new/changed members)
  storeB: GraphStore;
  orgB: OrgId; // target
  category?: string;
  /** Keep managed-package items that are in one org only. Default false. */
  includeManaged?: boolean;
  /** Keep standard objects and fields that are in one org only. Default false. */
  includeStandard?: boolean;
}

export function generateManifest(args: GenerateManifestArgs): DeploymentManifest;
export function generateManifest(
  store: GraphStore,
  orgA: OrgId,
  orgB: OrgId,
  category?: string,
): DeploymentManifest;
export function generateManifest(
  storeOrArgs: GraphStore | GenerateManifestArgs,
  maybeOrgA?: OrgId,
  maybeOrgB?: OrgId,
  maybeCategory = "all",
): DeploymentManifest {
  let storeA: GraphStore;
  let storeB: GraphStore;
  let orgA: OrgId;
  let orgB: OrgId;
  let category: string;
  let includeManaged = false;
  let includeStandard = false;
  if (
    typeof storeOrArgs === "object" &&
    storeOrArgs !== null &&
    "storeA" in storeOrArgs &&
    "storeB" in storeOrArgs
  ) {
    const a = storeOrArgs as GenerateManifestArgs;
    storeA = a.storeA;
    storeB = a.storeB;
    orgA = a.orgA;
    orgB = a.orgB;
    category = a.category ?? "all";
    includeManaged = a.includeManaged === true;
    includeStandard = a.includeStandard === true;
  } else {
    storeA = storeOrArgs as GraphStore;
    storeB = storeOrArgs as GraphStore;
    orgA = maybeOrgA as OrgId;
    orgB = maybeOrgB as OrgId;
    category = maybeCategory;
  }

  const diff = hideOneSided(diffOrgs({ storeA, orgA, storeB, orgB, category }), {
    includeManaged,
    includeStandard,
  });
  const apiVersion = storeA.getOrg(orgA)?.apiVersion ?? "59.0";

  const pkgMembers = new Map<string, Set<string>>();
  const destMembers = new Map<string, Set<string>>();
  const byType: Record<string, number> = {};

  const unmappedLabels: Record<string, number> = {};
  const add = (
    target: Map<string, Set<string>>,
    label: string,
    qname: string,
    attributes?: unknown,
  ): void => {
    const type = metadataTypeFor(label, attributes as Record<string, unknown> | undefined);
    const name = type ? formatMemberName(label, qname) : null;
    if (!type || !name) {
      // No Metadata API type mapping (or no formattable member name): this
      // changed component cannot go in package.xml. Record it instead of
      // silently dropping it, so the manifest can flag itself incomplete.
      unmappedLabels[label] = (unmappedLabels[label] ?? 0) + 1;
      return;
    }
    let set = target.get(type);
    if (!set) {
      set = new Set();
      target.set(type, set);
    }
    set.add(name);
    byType[type] = (byType[type] ?? 0) + 1;
  };

  // A member (an ApexMethod inside its ApexClass, see containment.ts) is
  // deployed with its owner: the owner's source changes with it, so the
  // owner's own diff entry carries it. It is neither unmapped nor destructive.
  // One indexed query on the containment table per entry.
  const isMember = (store: GraphStore, org: OrgId, qname: NodeFact["qualifiedName"]): boolean =>
    ownerOf(store, org, qname) !== null;

  for (const n of diff.onlyInA) {
    if (!isMember(storeA, orgA, n.qualifiedName))
      add(pkgMembers, n.label, n.qualifiedName, n.attributes);
  }
  for (const { a } of diff.changed) {
    if (!isMember(storeA, orgA, a.qualifiedName))
      add(pkgMembers, a.label, a.qualifiedName, a.attributes);
  }
  for (const n of diff.onlyInB) {
    if (!isMember(storeB, orgB, n.qualifiedName))
      add(destMembers, n.label, n.qualifiedName, n.attributes);
  }

  // Final invariant: one logical component (metadata type + member name, compared the way the
  // store compares names) is never in both package.xml and destructiveChanges.xml. The diff
  // already matches case-only differences, so this is the backstop for any other way two entries
  // can name one member (for example several sharing rules of one object share the member).
  const droppedFromDestructive: Array<{ type: string; member: string }> = [];
  const pkgKeys = new Set<string>();
  for (const [type, set] of pkgMembers) for (const m of set) pkgKeys.add(`${type}\0${nameKey(m)}`);
  for (const [type, set] of destMembers) {
    for (const m of [...set]) {
      if (!pkgKeys.has(`${type}\0${nameKey(m)}`)) continue;
      set.delete(m);
      droppedFromDestructive.push({ type, member: m });
      byType[type] = Math.max(0, (byType[type] ?? 0) - 1);
    }
  }

  return {
    packageXml: buildPackage(pkgMembers, apiVersion),
    destructiveXml: buildPackage(destMembers, apiVersion),
    summary: {
      apiVersion,
      addedOrChanged: diff.onlyInA.length + diff.changed.length,
      removed: Math.max(0, diff.onlyInB.length - droppedFromDestructive.length),
      byType,
    },
    incomplete: {
      diffTruncated: diff.truncated === true,
      unmappedLabels,
    },
    hidden: diff.hidden,
    droppedFromDestructive,
  };
}
