import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { asOrgId, asQualifiedName, asSha256 } from "@ryanstark24/sfgraph-shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { REL_TYPES } from "../../domain/index.js";
import type { EdgeFact, NodeFact } from "../../domain/index.js";
import { FilesystemMetadataSource } from "../../extractors/filesystem/index.js";
import type { IndexedMember } from "../../extractors/interfaces/metadata-source.js";
import type { ParseContext } from "../../parsers/contract.js";
import { parserRegistry } from "../../parsers/registry.js";
import { SqliteGraphStore } from "../../storage/sqlite/graph-store.js";
import { membersOwningFiles, selectOwningMembers } from "../wip-changed-files.js";
import { analyzeLocalImpact } from "../wip-impact.js";

// T14 batch L: wip changed-only mode reads (load()s) only the members that can
// own a changed file, reports deleted tracked files as removed, and wip_diff
// can skip the dependents pass. Results are otherwise unchanged (pinned).

let dir: string;
let store: SqliteGraphStore;
const orgId = asOrgId("org_wipL");

function seed(qname: string, label: string, hash = "seeded"): NodeFact {
  return {
    orgId,
    qualifiedName: asQualifiedName(qname),
    label,
    attributes: {},
    sourceHash: asSha256(hash),
    firstSeenAt: 1,
    lastSeenAt: 1,
    lastModifiedAt: 1,
  };
}
function edge(src: string, dst: string, rel: string): EdgeFact {
  return {
    orgId,
    srcQualifiedName: asQualifiedName(src),
    dstQualifiedName: asQualifiedName(dst),
    relType: rel as never,
    attributes: {},
    firstSeenAt: 1,
    lastSeenAt: 1,
  };
}
function w(rel: string, c: string): string {
  const abs = path.join(dir, rel);
  mkdirSync(path.dirname(abs), { recursive: true });
  writeFileSync(abs, c, "utf8");
  return abs;
}
const git = (...args: string[]) =>
  execFileSync(
    "git",
    [
      "-c",
      "user.email=t@t",
      "-c",
      "user.name=t",
      "-c",
      "core.hooksPath=/dev/null",
      "-c",
      "core.fsmonitor=false",
      ...args,
    ],
    { cwd: dir, stdio: "ignore" },
  );

const NS = "%vlocity_namespace%__";
const CLS = "force-app/main/default/classes";
const OBJ = "force-app/main/default/objects";
const LWC = "force-app/main/default/lwc";

/** A committed tree with classes, an object with fields, an LWC bundle and a DataPack. */
function buildTree(): void {
  w("sfdx-project.json", JSON.stringify({ packageDirectories: [{ path: "force-app" }] }));
  for (const c of ["Alpha", "Beta", "Gamma", "Delta"]) {
    w(`${CLS}/${c}.cls`, `public class ${c} { public void run() {} }`);
    w(`${CLS}/${c}.cls-meta.xml`, "<ApexClass/>");
  }
  w(`${OBJ}/Widget__c/Widget__c.object-meta.xml`, "<CustomObject><label>W</label></CustomObject>");
  w(
    `${OBJ}/Widget__c/fields/Size__c.field-meta.xml`,
    "<CustomField><type>Number</type></CustomField>",
  );
  w(`${OBJ}/Account/fields/Tier__c.field-meta.xml`, "<CustomField><type>Text</type></CustomField>");
  w(`${LWC}/panel/panel.js`, "export default class Panel {}");
  w(`${LWC}/panel/panel.html`, "<template></template>");
  w(`${LWC}/panel/panel.js-meta.xml`, "<LightningComponentBundle/>");
  const dr = "vlocity/datapacks/DataRaptor/WidgetFetch";
  w(
    `${dr}/WidgetFetch_DataPack.json`,
    JSON.stringify({ Name: "WidgetFetch", [`${NS}Type__c`]: "Extract" }),
  );
  git("init", "-q");
  git("add", "-A");
  git("commit", "-q", "-m", "init");
}

/** Edits that touch a direct member, a sidecar, a field, a bundle file, a
 *  shared-folder stray and a new class. */
function editTree(): void {
  w(`${CLS}/Alpha.cls`, "public class Alpha { public void run() { Beta b; } }");
  w(`${CLS}/Gamma.cls-meta.xml`, "<ApexClass><status>Active</status></ApexClass>");
  w(`${CLS}/README.md`, "stray file in a shared folder");
  w(`${CLS}/Epsilon.cls`, "public class Epsilon {}");
  w(
    `${OBJ}/Widget__c/fields/Size__c.field-meta.xml`,
    "<CustomField><type>Text</type></CustomField>",
  );
  w(
    `${OBJ}/Account/fields/Tier__c.field-meta.xml`,
    "<CustomField><type>Number</type></CustomField>",
  );
  w(`${LWC}/panel/panel.html`, "<template><p>hi</p></template>");
  w(
    "vlocity/datapacks/DataRaptor/WidgetFetch/WidgetFetch_DataPack.json",
    JSON.stringify({ Name: "WidgetFetch", [`${NS}Type__c`]: "Load" }),
  );
}

function seedGraph(): void {
  store.upsertOrg({
    id: orgId,
    alias: "wipL",
    instanceUrl: "https://example",
    apiVersion: "60.0",
    createdAt: 1,
  });
  store.mergeNodes([
    seed("ApexClass:Alpha", "ApexClass"),
    seed("ApexClass:Beta", "ApexClass"),
    seed("ApexClass:Gamma", "ApexClass"),
    seed("ApexClass:Delta", "ApexClass"),
    seed("ApexClass:Caller", "ApexClass"),
    seed("ApexClass:CallerTest", "ApexClass"),
    seed("CustomObject:Widget__c", "CustomObject"),
    seed("CustomField:Widget__c.Size__c", "CustomField"),
    seed("CustomField:Account.Tier__c", "CustomField"),
    seed("LWC:panel", "LWC"),
  ]);
  store.mergeEdges([
    edge("ApexClass:Caller", "ApexClass:Alpha", REL_TYPES.CALLS),
    edge("ApexClass:CallerTest", "ApexClass:Caller", REL_TYPES.IS_TEST_FOR),
    edge("LWC:panel", "ApexClass:Caller", REL_TYPES.CALLS),
  ]);
}

beforeEach(async () => {
  dir = mkdtempSync(path.join(tmpdir(), "sfg-wipL-"));
  store = new SqliteGraphStore({ dbPath: ":memory:" });
  await store.init();
});
afterEach(async () => {
  vi.restoreAllMocks();
  await store.close();
  rmSync(dir, { recursive: true, force: true });
});

const run = (extra: Record<string, unknown> = {}) =>
  analyzeLocalImpact({ graphStore: store, orgId, projectRoot: dir, ...extra });

describe("wip changed-only logs a skipped git signal (review I3)", () => {
  it("passes its logger down to the git signal", async () => {
    buildTree();
    seedGraph();
    // A filter driver name `-c` cannot pass safely: the git signal is skipped.
    git("config", "filter.a=b.clean", "cat");
    editTree();
    const debug: string[] = [];
    const logger = {
      debug: (m: string) => debug.push(m),
      info: () => {},
      warn: () => {},
      error: () => {},
    };
    await run({ depth: 1, logger });
    expect(debug.filter((m) => /git signal skipped/.test(m))).toHaveLength(1);
  });
});

describe("wip dependents: depth and diagram with folded and component-hop rows (review I5b/c)", () => {
  function foldGraph(): void {
    store.mergeNodes([
      seed("Flow:F", "Flow"),
      seed("FlowVersion:F.v1", "FlowVersion"),
      seed("Flow:G", "Flow"),
      seed("FlowVersion:G.v1", "FlowVersion"),
      seed("ApexClass:Mid", "ApexClass"),
      seed("ApexMethod:Mid.a(0)", "ApexMethod"),
      seed("ApexMethod:Mid.b(0)", "ApexMethod"),
      seed("ApexClass:Top", "ApexClass"),
      seed("ApexClass:Ref", "ApexClass"),
    ]);
    store.mergeEdges([
      edge("Flow:F", "FlowVersion:F.v1", REL_TYPES.CONTAINS),
      edge("FlowVersion:F.v1", "ApexClass:Alpha", REL_TYPES.FLOW_INVOKES_APEX),
      edge("Flow:G", "FlowVersion:G.v1", REL_TYPES.CONTAINS),
      edge("FlowVersion:G.v1", "Flow:F", REL_TYPES.FLOW_INVOKES_SUBFLOW),
      edge("ApexClass:Mid", "ApexMethod:Mid.a(0)", REL_TYPES.CONTAINS_METHOD),
      edge("ApexClass:Mid", "ApexMethod:Mid.b(0)", REL_TYPES.CONTAINS_METHOD),
      edge("ApexMethod:Mid.a(0)", "ApexClass:Alpha", REL_TYPES.REFERENCES),
      // T15 ruling: wip_impact hops are component-level, so a caller of the
      // reached method's sibling is a dependent, as is a class-level reference.
      edge("ApexClass:Top", "ApexMethod:Mid.b(0)", REL_TYPES.CALLS),
      edge("ApexClass:Ref", "ApexClass:Mid", REL_TYPES.REFERENCES),
    ]);
  }

  it("reports each dependent's traversal hop and rel, not a depth-1 fallback", async () => {
    buildTree();
    seedGraph();
    foldGraph();
    editTree();
    const r = await run({ depth: 3 });
    const by = new Map(r.dependents.map((d) => [d.qname, d]));
    expect(by.get("Flow:F")).toMatchObject({ depth: 1, viaRelType: REL_TYPES.FLOW_INVOKES_APEX });
    expect(by.get("Flow:G")).toMatchObject({
      depth: 2,
      viaRelType: REL_TYPES.FLOW_INVOKES_SUBFLOW,
    });
    expect(by.get("ApexMethod:Mid.a(0)")).toMatchObject({ depth: 1 });
    expect(by.get("ApexClass:Top")).toMatchObject({ depth: 2, viaRelType: REL_TYPES.CALLS });
    expect(by.get("ApexClass:Ref")).toMatchObject({ depth: 2, viaRelType: REL_TYPES.REFERENCES });
    expect(by.has("FlowVersion:F.v1")).toBe(false);
  });

  it("draws edges between listed rows (folded and sibling endpoints remapped)", async () => {
    buildTree();
    seedGraph();
    foldGraph();
    editTree();
    const r = await run({ depth: 3 });
    expect(r.mermaid).toContain("Flow_F -->|FLOW_INVOKES_APEX| ApexClass_Alpha");
    expect(r.mermaid).toContain("Flow_G -->|FLOW_INVOKES_SUBFLOW| Flow_F");
    expect(r.mermaid).toContain("ApexClass_Ref -->|REFERENCES| ApexMethod_Mid_a_0_");
    expect(r.mermaid).toContain("ApexClass_Top -->|CALLS| ApexMethod_Mid_a_0_");
  });
});

describe("wip changed-only output pin", () => {
  it("is unchanged for a mixed edit set (sets, order, dependents, mermaid)", async () => {
    buildTree();
    seedGraph();
    editTree();
    const r = await run({ depth: 3 });
    expect({
      changed: r.changedQnames,
      added: r.addedQnames,
      removed: r.removedQnames,
      dependents: r.dependents,
      truncated: r.truncated,
    }).toMatchInlineSnapshot(`
      {
        "added": [
          "ApexMethod:Alpha.run(0)",
          "ApexClass:Epsilon",
          "ApexMethod:Gamma.run(0)",
          "LWCBundle:panel",
          "CustomObject:Account",
          "DataRaptor:WidgetFetch",
        ],
        "changed": [
          "ApexClass:Alpha",
          "ApexClass:Gamma",
          "LWC:panel",
          "CustomField:Account.Tier__c",
          "CustomObject:Widget__c",
          "CustomField:Widget__c.Size__c",
        ],
        "dependents": [
          {
            "coveredByTest": true,
            "depth": 1,
            "label": "ApexClass",
            "qname": "ApexClass:Caller",
            "viaRelType": "CALLS",
          },
          {
            "coveredByTest": false,
            "depth": 2,
            "label": "LWC",
            "qname": "LWC:panel",
            "viaRelType": "CALLS",
          },
          {
            "coveredByTest": false,
            "depth": 2,
            "label": "ApexClass",
            "qname": "ApexClass:CallerTest",
            "viaRelType": "IS_TEST_FOR",
          },
        ],
        "removed": [],
        "truncated": false,
      }
    `);
    expect(r.mermaid).toMatchInlineSnapshot(`
      "flowchart LR
        classDef wip-changed fill:#d0021b,color:#fff,stroke:#333
        classDef wip-added fill:#4a90e2,color:#fff,stroke:#333
        classDef risk fill:#f5a623,color:#000,stroke:#333
        classDef safe fill:#7ed321,color:#000,stroke:#333
        ApexClass_Alpha["ApexClass:Alpha"]
        ApexClass_Gamma["ApexClass:Gamma"]
        LWC_panel["LWC:panel"]
        CustomField_Account_Tier__c["CustomField:Account.Tier__c"]
        CustomObject_Widget__c["CustomObject:Widget__c"]
        CustomField_Widget__c_Size__c["CustomField:Widget__c.Size__c"]
        ApexMethod_Alpha_run_0_["ApexMethod:Alpha.run(0)"]
        ApexClass_Epsilon["ApexClass:Epsilon"]
        ApexMethod_Gamma_run_0_["ApexMethod:Gamma.run(0)"]
        LWCBundle_panel["LWCBundle:panel"]
        CustomObject_Account["CustomObject:Account"]
        DataRaptor_WidgetFetch["DataRaptor:WidgetFetch"]
        ApexClass_Caller["ApexClass:Caller"]
        ApexClass_CallerTest["ApexClass:CallerTest"]
        ApexClass_Caller -->|CALLS| ApexClass_Alpha
        LWC_panel -->|CALLS| ApexClass_Caller
        ApexClass_CallerTest -->|IS_TEST_FOR| ApexClass_Caller
        class ApexClass_Alpha wip-changed
        class ApexClass_Gamma wip-changed
        class LWC_panel wip-changed
        class CustomField_Account_Tier__c wip-changed
        class CustomObject_Widget__c wip-changed
        class CustomField_Widget__c_Size__c wip-changed
        class ApexMethod_Alpha_run_0_ wip-added
        class ApexClass_Epsilon wip-added
        class ApexMethod_Gamma_run_0_ wip-added
        class LWCBundle_panel wip-added
        class CustomObject_Account wip-added
        class DataRaptor_WidgetFetch wip-added
        class ApexClass_Caller safe
        class ApexClass_CallerTest risk"
    `);
  });
});

/** Records the basename of every member load()ed through iterIndexed. */
function spyLoads(): string[] {
  const orig = FilesystemMetadataSource.prototype.iterIndexed;
  const loaded: string[] = [];
  vi.spyOn(FilesystemMetadataSource.prototype, "iterIndexed").mockImplementation(async function* (
    this: FilesystemMetadataSource,
  ): AsyncGenerator<IndexedMember> {
    for await (const e of orig.call(this)) {
      yield {
        ...e,
        load: () => {
          loaded.push(path.basename(e.key));
          return e.load();
        },
      };
    }
  });
  return loaded;
}

describe("wip changed-only reads only candidate members", () => {
  it("loads only the edited class, not its siblings", async () => {
    buildTree();
    seedGraph();
    w(`${CLS}/Alpha.cls`, "public class Alpha { public void run() { Beta b; } }");
    const loaded = spyLoads();
    const r = await run();
    expect(loaded).toEqual(["Alpha.cls"]);
    expect(r.changedQnames).toEqual(["ApexClass:Alpha"]);
  });

  it("never calls iter() and loads only members anchored at a changed path", async () => {
    buildTree();
    seedGraph();
    w(`${CLS}/../flows/OnlyFlow.flow-meta.xml`, "<Flow/>");
    git("add", "-A");
    git("commit", "-q", "-m", "flow");
    // Only the object field changes: nothing under classes/ may be read.
    w(
      `${OBJ}/Widget__c/fields/Size__c.field-meta.xml`,
      "<CustomField><type>Text</type></CustomField>",
    );
    const iter = vi.spyOn(FilesystemMetadataSource.prototype, "iter");
    const loaded = spyLoads();
    const r = await run();
    expect(iter).not.toHaveBeenCalled();
    expect(loaded).toEqual(["Widget__c.object-meta.xml"]);
    expect(r.changedQnames).toContain("CustomField:Widget__c.Size__c");
  });
});

describe("wip changed-only reports deleted tracked files as removed", () => {
  it("maps a deleted class (and its sidecar) to the persisted node", async () => {
    buildTree();
    seedGraph();
    unlinkSync(path.join(dir, `${CLS}/Delta.cls`));
    unlinkSync(path.join(dir, `${CLS}/Delta.cls-meta.xml`));
    const r = await run();
    expect(r.removedQnames).toEqual(["ApexClass:Delta"]);
    expect(r.changedQnames).toEqual([]);
    expect(r.addedQnames).toEqual([]);
  });

  it("ignores a deleted file with no persisted node, or whose member still exists", async () => {
    buildTree();
    seedGraph();
    store.deleteNode(orgId, asQualifiedName("ApexClass:Beta"));
    unlinkSync(path.join(dir, `${CLS}/Beta.cls`));
    // A file of a bundle that is still there: the bundle is changed, not removed.
    unlinkSync(path.join(dir, `${LWC}/panel/panel.html`));
    const r = await run();
    expect(r.removedQnames).toEqual([]);
    expect(r.changedQnames).toEqual(["LWC:panel"]);
  });
});

describe("deletion mapping is scoped, case-blind and keeps unparsed survivors", () => {
  it("ignores a deleted copy outside the package dirs", async () => {
    buildTree();
    seedGraph();
    w("docs/classes/Gamma.cls", "public class Gamma {}");
    git("add", "-A");
    git("commit", "-q", "-m", "docs");
    unlinkSync(path.join(dir, "docs/classes/Gamma.cls"));
    const r = await run();
    expect(r.removedQnames).toEqual([]);
  });

  it("maps the path relative to the project root (root under an lwc/ folder)", async () => {
    const outer = dir;
    dir = path.join(outer, "lwc", "proj");
    try {
      buildTree();
      seedGraph();
      w("force-app/main/default/flows/OnlyFlow.flow-meta.xml", "<Flow/>");
      git("add", "-A");
      git("commit", "-q", "-m", "flow");
      store.mergeNodes([seed("Flow:OnlyFlow", "Flow")]);
      unlinkSync(path.join(dir, "force-app/main/default/flows/OnlyFlow.flow-meta.xml"));
      const r = await run();
      expect(r.removedQnames).toEqual(["Flow:OnlyFlow"]);
    } finally {
      dir = outer;
    }
  });

  it("does not report a member still produced under another case", async () => {
    buildTree();
    seedGraph();
    unlinkSync(path.join(dir, `${CLS}/Delta.cls`));
    unlinkSync(path.join(dir, `${CLS}/Delta.cls-meta.xml`));
    w(`${CLS}/Renamed.cls`, "public class DELTA { public void run() {} }");
    w(`${CLS}/Renamed.cls-meta.xml`, "<ApexClass/>");
    const r = await run();
    expect(r.removedQnames).toEqual([]);
  });

  it("does not report a surviving member that fails to parse", async () => {
    buildTree();
    seedGraph();
    unlinkSync(path.join(dir, `${CLS}/Beta.cls-meta.xml`));
    const orig = parserRegistry.for.bind(parserRegistry);
    vi.spyOn(parserRegistry, "for").mockImplementation((type: string) => {
      const p = orig(type);
      if (!p) return p;
      return {
        ...p,
        parse: (input: unknown, ctx: ParseContext) => {
          if (ctx.sourceUri.endsWith("Beta.cls")) throw new Error("boom");
          return p.parse(input, ctx);
        },
      } as typeof p;
    });
    const r = await run();
    expect(r.removedQnames).toEqual([]);
  });

  it("reports a deleted field of an object with no object file", async () => {
    buildTree();
    seedGraph();
    unlinkSync(path.join(dir, `${OBJ}/Account/fields/Tier__c.field-meta.xml`));
    const r = await run();
    expect(r.removedQnames).toEqual(["CustomField:Account.Tier__c"]);
  });
});

describe("skipDependents", () => {
  it("returns the same sets with no dependents pass", async () => {
    buildTree();
    seedGraph();
    editTree();
    const full = await run();
    const spy = vi.spyOn(store, "listEdgesTo");
    const lean = await run({ skipDependents: true });
    expect(spy).not.toHaveBeenCalled();
    expect(lean.changedQnames).toEqual(full.changedQnames);
    expect(lean.addedQnames).toEqual(full.addedQnames);
    expect(lean.removedQnames).toEqual(full.removedQnames);
    expect(lean.dependents).toEqual([]);
  });
});

describe("selectOwningMembers = full membersOwningFiles", () => {
  it("owns the same members on random trees (incl. grandparent anchors)", async () => {
    // Deterministic LCG so a failure reproduces.
    let seedN = 12345;
    const rnd = (n: number) => {
      seedN = (seedN * 1103515245 + 12345) % 2147483648;
      return seedN % n;
    };
    const names = ["A", "B", "fields", "x"];
    let forcedOwned = 0;
    let rounds = 0;
    for (let round = 0; round < 400; round++) {
      const root = mkdtempSync(path.join(tmpdir(), "sfg-wipL-sel-"));
      try {
        const files: string[] = [];
        const refs: Array<{ sourceUri: string; memberName: string }> = [];
        let forced: string | null = null;
        if (round % 4 === 0) {
          // A file member named after its grandparent that is the sole anchor
          // of a changed stray file there: only the upper-anchor pass finds it.
          const m = path.join(root, "A", "x", "m.f");
          const stray = path.join(root, "A", "s.f");
          mkdirSync(path.dirname(m), { recursive: true });
          writeFileSync(m, "x");
          writeFileSync(stray, "x");
          files.push(stray);
          forced = `file://${m}`;
          refs.push({ sourceUri: forced, memberName: "A" });
        }
        if (round % 4 === 1) {
          // The same upper anchor, but its folder also anchors two unchanged
          // file members that are never loaded: nobody owns the stray.
          const m = path.join(root, "B", "x", "m.f");
          mkdirSync(path.dirname(m), { recursive: true });
          writeFileSync(m, "x");
          refs.push({ sourceUri: `file://${m}`, memberName: "B" });
          for (const n of ["m1.f", "m2.f"]) {
            writeFileSync(path.join(root, "B", n), "x");
            refs.push({ sourceUri: `file://${path.join(root, "B", n)}`, memberName: "zz" });
          }
          const stray = path.join(root, "B", "s.f");
          writeFileSync(stray, "x");
          files.push(stray);
        }
        const nFiles = 2 + rnd(8);
        for (let k = 0; k < nFiles; k++) {
          const depth = 1 + rnd(3);
          const segs = Array.from({ length: depth }, () => names[rnd(names.length)] as string);
          const f = path.join(root, ...segs, `${names[rnd(names.length)]}.f${k}`);
          mkdirSync(path.dirname(f), { recursive: true });
          writeFileSync(f, "x");
          files.push(f);
        }
        for (const f of files) {
          if (rnd(3) === 0) continue; // stray file, no member
          const asDir = rnd(4) === 0;
          const p = asDir ? path.dirname(f) : f;
          const up = rnd(3);
          let named = path.dirname(p);
          for (let k = 0; k < up; k++) named = path.dirname(named);
          const memberName = rnd(2) === 0 ? path.basename(named) : "zz";
          if (!refs.some((r) => r.sourceUri === `file://${p}`)) {
            refs.push({ sourceUri: `file://${p}`, memberName });
          }
        }
        // Members in a folder no change touches: never loaded.
        for (const n of ["p", "q", "r"]) {
          const f = path.join(root, "far", n, `${n}.f`);
          mkdirSync(path.dirname(f), { recursive: true });
          writeFileSync(f, "x");
          refs.push({ sourceUri: `file://${f}`, memberName: "far" });
        }
        const changed = new Set(
          files.filter((_, k) => (round % 4 <= 1 && k === 0) || rnd(3) === 0),
        );
        if (changed.size === 0) continue;
        const want = [...membersOwningFiles(refs, changed)].map((i) => refs[i]?.sourceUri).sort();
        const byKey = new Map(refs.map((r) => [r.sourceUri, r]));
        const sel = await selectOwningMembers(
          refs.map((r) => ({ key: r.sourceUri })),
          changed,
          async (e) => ({ ref: byKey.get(e.key) as (typeof refs)[number] }),
        );
        const got = [...sel.direct, ...sel.owners].map((m) => m.ref.sourceUri).sort();
        expect(got, `round ${round}`).toEqual(want);
        if (forced && got.includes(forced)) forcedOwned++;
        expect(sel.indexed - sel.loaded, `round ${round}`).toBeGreaterThanOrEqual(3);
        rounds++;
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    }
    expect(forcedOwned).toBeGreaterThan(10);
    expect(rounds).toBeGreaterThan(200);
  });
});

describe("T15 I-6: removed qnames seed the dependents pass", () => {
  it("a deleted class's callers are dependents", async () => {
    buildTree();
    seedGraph();
    store.mergeNodes([seed("ApexClass:UsesDelta", "ApexClass")]);
    store.mergeEdges([edge("ApexClass:UsesDelta", "ApexClass:Delta", REL_TYPES.CALLS)]);
    unlinkSync(path.join(dir, `${CLS}/Delta.cls`));
    unlinkSync(path.join(dir, `${CLS}/Delta.cls-meta.xml`));
    const r = await run();
    expect(r.removedQnames).toEqual(["ApexClass:Delta"]);
    expect(r.dependents.map((d) => [d.qname, d.depth, d.viaRelType])).toEqual([
      ["ApexClass:UsesDelta", 1, REL_TYPES.CALLS],
    ]);
    expect(r.mermaid).toContain("ApexClass_UsesDelta -->|CALLS| ApexClass_Delta");
  });
});
