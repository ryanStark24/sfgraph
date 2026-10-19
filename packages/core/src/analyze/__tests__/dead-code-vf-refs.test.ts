import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { type OrgId, asOrgId, asQualifiedName, asSha256 } from "@ryanstark24/sfgraph-shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { EdgeFact, NodeFact } from "../../domain/index.js";
import { makeTestCtx } from "../../parsers/__tests__/_harness.js";
import { ApexClassParser } from "../../parsers/apex/class.js";
import { loadAllRules, parserRegistry } from "../../parsers/index.js";
import { SqliteGraphStore } from "../../storage/sqlite/graph-store.js";
import { findDeadCode } from "../dead-code.js";

/**
 * A Visualforce component or page used only from markup (`<c:X>`,
 * `<apex:include>`, `<apex:composition>`, `$Page.X`) or from Apex (`Page.X`)
 * is in use: the parsers' REFERENCES edges count for the dead-code audit.
 */
const ORG: OrgId = asOrgId("org_test");
let workDir: string;
let store: SqliteGraphStore;

beforeEach(async () => {
  workDir = mkdtempSync(path.join(tmpdir(), "sfg-dc-vf-"));
  store = new SqliteGraphStore({
    dbPath: path.join(workDir, "g.sqlite"),
    backupDir: path.join(workDir, "b"),
  });
  await store.init();
});
afterEach(async () => {
  await store.close();
  rmSync(workDir, { recursive: true, force: true });
});

function stale(label: string, name: string): NodeFact {
  return {
    orgId: ORG,
    qualifiedName: asQualifiedName(`${label}:${name}`),
    label,
    attributes: { name },
    sourceHash: asSha256("h"),
    firstSeenAt: 1,
    lastSeenAt: 1,
    lastModifiedAt: 1,
  };
}

async function parseVf(type: string, name: string, xml: string) {
  await loadAllRules();
  return parserRegistry.for(type)!.parse({ name, xml } as never, makeTestCtx());
}

describe("dead code: Visualforce references", () => {
  it("components and pages used only from markup or Page.X are not dead", async () => {
    const shell = await parseVf(
      "ApexPage",
      "Shell",
      `<apex:page><apex:composition template="Tmpl"/><c:Card/><apex:include pageName="Footer"/>{!$Page.Help}</apex:page>`,
    );
    const ctrl = await new ApexClassParser().parse(
      {
        className: "ShellCtrl",
        body: "public class ShellCtrl { PageReference go() { return Page.Shell; } }",
      },
      makeTestCtx(),
    );
    store.mergeNodes([
      stale("ApexComponent", "Card"),
      stale("ApexComponent", "Unused"),
      stale("ApexPage", "Tmpl"),
      stale("ApexPage", "Footer"),
      stale("ApexPage", "Help"),
      stale("ApexPage", "Orphan"),
    ]);
    store.mergeNodes([...shell.nodes, ...ctrl.nodes] as NodeFact[]);
    store.mergeEdges([...shell.edges, ...ctrl.edges] as EdgeFact[]);

    const dead = findDeadCode(store, ORG)
      .map((n) => String(n.qualifiedName))
      .filter((q) => q.startsWith("ApexPage:") || q.startsWith("ApexComponent:"))
      .sort();
    // Shell is reached from ShellCtrl (Page.Shell); the rest from Shell's markup.
    expect(dead).toEqual(["ApexComponent:Unused", "ApexPage:Orphan"]);
  });
});
