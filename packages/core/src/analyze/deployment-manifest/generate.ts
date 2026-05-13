import type { OrgId } from "@sfgraph/shared";
import type { GraphStore } from "../../storage/interfaces.js";
import { diffOrgs } from "../cross-org.js";
import { formatMemberName } from "./member-name-formatters.js";
import { LABEL_TO_METADATA_TYPE } from "./member-types.js";

export interface DeploymentManifest {
  packageXml: string;
  destructiveXml: string;
  summary: {
    apiVersion: string;
    addedOrChanged: number;
    removed: number;
    byType: Record<string, number>;
  };
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

export function generateManifest(
  store: GraphStore,
  orgA: OrgId, // source (has new/changed members)
  orgB: OrgId, // target
  category = "all",
): DeploymentManifest {
  const diff = diffOrgs(store, orgA, orgB, category);
  const apiVersion = store.getOrg(orgA)?.apiVersion ?? "59.0";

  const pkgMembers = new Map<string, Set<string>>();
  const destMembers = new Map<string, Set<string>>();
  const byType: Record<string, number> = {};

  const add = (target: Map<string, Set<string>>, label: string, qname: string): void => {
    const type = LABEL_TO_METADATA_TYPE[label];
    if (!type) return;
    const name = formatMemberName(label, qname);
    if (!name) return;
    let set = target.get(type);
    if (!set) {
      set = new Set();
      target.set(type, set);
    }
    set.add(name);
    byType[type] = (byType[type] ?? 0) + 1;
  };

  for (const n of diff.onlyInA) add(pkgMembers, n.label, n.qualifiedName);
  for (const { a } of diff.changed) add(pkgMembers, a.label, a.qualifiedName);
  for (const n of diff.onlyInB) add(destMembers, n.label, n.qualifiedName);

  return {
    packageXml: buildPackage(pkgMembers, apiVersion),
    destructiveXml: buildPackage(destMembers, apiVersion),
    summary: {
      apiVersion,
      addedOrChanged: diff.onlyInA.length + diff.changed.length,
      removed: diff.onlyInB.length,
      byType,
    },
  };
}
