import * as fs from "node:fs";
import * as path from "node:path";
import { METADATA_CATEGORY, type MetadataCategory } from "../../domain/metadata-category.js";
import type {
  IndexedMember,
  MemberRef,
  MetadataSource,
  RawMember,
} from "../interfaces/metadata-source.js";
import { VLOCITY_NAMESPACE_CANDIDATES } from "../live-org/capabilities.js";
import { type DataPackReport, indexDataPacks } from "./vlocity-datapacks.js";

const SKIP_DIR_NAMES = new Set(["node_modules", ".git", "dist", "coverage", ".sfdx", ".sf"]);

/**
 * Filesystem-based metadata source. Walks an sfdx source-format tree and
 * yields RawMember records for each known metadata file/bundle.
 *
 * Strictly read-only: parses the layout to seed in-memory parsers; never
 * writes to disk or to the persisted graph.
 */
export class FilesystemMetadataSource implements MetadataSource {
  readonly rootDir: string;
  readonly packageDirs: string[];
  /** Populated while iter() walks vlocity/datapacks (type counts + skipped packs). */
  readonly dataPackReport: DataPackReport = { skipped: [], types: {} };

  constructor(rootDir: string, packageDirs?: string[]) {
    this.rootDir = rootDir;
    this.packageDirs = packageDirs && packageDirs.length > 0 ? packageDirs : ["force-app"];
  }

  /**
   * Build a source by reading `sfdx-project.json` for packageDirectories.
   * Falls back to `force-app` if the file is missing or malformed.
   */
  static fromProjectRoot(root: string): FilesystemMetadataSource {
    const projectFile = path.join(root, "sfdx-project.json");
    let dirs: string[] | undefined;
    try {
      if (fs.existsSync(projectFile)) {
        const raw = fs.readFileSync(projectFile, "utf8");
        const parsed = JSON.parse(raw) as { packageDirectories?: Array<{ path?: string }> };
        const arr = Array.isArray(parsed.packageDirectories) ? parsed.packageDirectories : [];
        dirs = arr
          .map((d) => d.path)
          .filter((p): p is string => typeof p === "string" && p.length > 0);
      }
    } catch {
      // tolerate malformed sfdx-project.json — fall back to default
      dirs = undefined;
    }
    return new FilesystemMetadataSource(root, dirs);
  }

  private unloaded = new Set<string>();

  unloadedKeys(): ReadonlySet<string> {
    return this.unloaded;
  }

  async *iter(): AsyncIterable<RawMember> {
    this.unloaded = new Set();
    for await (const e of this.iterIndexed()) {
      const m = await e.load();
      if (m && !m.unreadable) yield m;
      else this.unloaded.add(e.key);
    }
  }

  /**
   * Task 11c: every member as a cheap index entry, in `iter()` order.
   * Enumeration lists directories and stats files; nothing is read until
   * `load()`. Keys are the members' sourceUris; a member's fingerprint is
   * the size and mtime of each file it is built from (DataPacks add the
   * substituted namespace), and `load()` stamps it on the RawMember.
   */
  async *iterIndexed(): AsyncIterable<IndexedMember> {
    const objectNames = new Set<string>();
    for (const pkg of this.packageDirs) {
      const pkgRoot = path.resolve(this.rootDir, pkg);
      if (!safeIsDir(pkgRoot)) continue;
      yield* walkPackage(pkgRoot, objectNames);
    }
    const dp = path.join(this.rootDir, "vlocity", "datapacks");
    if (safeIsDir(dp)) {
      const packs = indexDataPacks(dp, this.dataPackReport, {
        vlocityNamespace: detectVlocityNamespace(objectNames),
      });
      for await (const e of packs) {
        yield {
          ...e,
          load: async () => {
            const m = await e.load();
            return m ? { ...m, fingerprint: e.fingerprint } : null;
          },
        };
      }
    }
  }
}

/** `name:size:mtimeMs` of a file ("name:-" when missing). */
function fileStamp(p: string, name = path.basename(p)): string {
  try {
    const st = fs.statSync(p);
    return `${name}:${st.size}:${st.mtimeMs}`;
  } catch {
    return `${name}:-`;
  }
}

/** Stamps of the files in `dir` ending in `suffix`, sorted ("" when absent). */
function dirStamps(dir: string, suffix: string): string {
  let names: string[];
  try {
    names = fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((f) => f.isFile() && f.name.endsWith(suffix))
      .map((f) => f.name)
      .sort();
  } catch {
    return "";
  }
  return names.map((n) => fileStamp(path.join(dir, n), n)).join("|");
}

function indexed(
  key: string,
  memberType: string,
  fingerprint: string,
  build: () => RawMember | null,
): IndexedMember {
  return {
    key,
    memberType,
    fingerprint,
    load: async () => {
      // build() is synchronous: failures counted meanwhile are this member's.
      const before = readFailures;
      const m = build();
      if (!m) return null;
      return readFailures > before
        ? { ...m, fingerprint, unreadable: true }
        : { ...m, fingerprint };
    },
  };
}

/**
 * The Vlocity package namespace the `%vlocity_namespace%` DataPack token
 * stands for, read from the source tree's object folder names (e.g.
 * `vlocity_cmt__QuoteMember__c`). The most frequent candidate wins (ties: candidate order); null
 * when the tree carries no Vlocity-namespaced objects.
 */
export function detectVlocityNamespace(objectNames: Iterable<string>): string | null {
  const counts = new Map<string, number>();
  for (const name of objectNames) {
    for (const ns of VLOCITY_NAMESPACE_CANDIDATES) {
      if (name.startsWith(`${ns}__`)) counts.set(ns, (counts.get(ns) ?? 0) + 1);
    }
  }
  // Ties go to the earlier candidate (deterministic, independent of walk order).
  let best: string | null = null;
  let bestN = 0;
  for (const ns of VLOCITY_NAMESPACE_CANDIDATES) {
    const n = counts.get(ns) ?? 0;
    if (n > bestN) {
      best = ns;
      bestN = n;
    }
  }
  return best;
}

function safeIsDir(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/** Reads that failed for a reason other than the file being absent. */
let readFailures = 0;

function safeReadFile(p: string): string {
  try {
    return fs.readFileSync(p, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") readFailures += 1;
    return "";
  }
}

function mtimeIso(p: string): string | null {
  try {
    return fs.statSync(p).mtime.toISOString();
  } catch {
    return null;
  }
}

interface MdLeafDirSpec {
  /** Folder name under the metadata root (or default "main" subroot). */
  segment: string;
  /** Filename suffix to match. */
  suffix: string;
  /** Parser type / memberType (matches parser registry key). */
  memberType: string;
  /** Metadata category for RawMember.ref.category. */
  category: MetadataCategory;
}

const LEAF_SPECS: MdLeafDirSpec[] = [
  {
    segment: "classes",
    suffix: ".cls",
    memberType: "ApexClass",
    category: METADATA_CATEGORY.APEX_CLASS,
  },
  {
    segment: "triggers",
    suffix: ".trigger",
    memberType: "ApexTrigger",
    category: METADATA_CATEGORY.APEX_TRIGGER,
  },
  {
    segment: "flows",
    suffix: ".flow-meta.xml",
    memberType: "Flow",
    category: METADATA_CATEGORY.FLOW,
  },
  {
    segment: "profiles",
    suffix: ".profile-meta.xml",
    memberType: "Profile",
    category: METADATA_CATEGORY.PROFILE,
  },
  {
    segment: "permissionsets",
    suffix: ".permissionset-meta.xml",
    memberType: "PermissionSet",
    category: METADATA_CATEGORY.PERMISSION_SET,
  },
  {
    segment: "permissionsetgroups",
    suffix: ".permissionsetgroup-meta.xml",
    memberType: "PermissionSetGroup",
    category: METADATA_CATEGORY.PERMISSION_SET_GROUP,
  },
  {
    segment: "sharingRules",
    suffix: ".sharingRules-meta.xml",
    memberType: "SharingRules",
    category: METADATA_CATEGORY.SHARING_RULE,
  },
  {
    segment: "namedCredentials",
    suffix: ".namedCredential-meta.xml",
    memberType: "NamedCredential",
    category: METADATA_CATEGORY.NAMED_CREDENTIAL,
  },
  {
    segment: "externalServiceRegistrations",
    suffix: ".externalServiceRegistration-meta.xml",
    memberType: "ExternalServiceRegistration",
    category: METADATA_CATEGORY.EXTERNAL_SERVICE_REGISTRATION,
  },
  {
    segment: "pages",
    suffix: ".page",
    memberType: "ApexPage",
    category: METADATA_CATEGORY.APEX_PAGE,
  },
  {
    segment: "components",
    suffix: ".component",
    memberType: "ApexComponent",
    category: METADATA_CATEGORY.APEX_COMPONENT,
  },
  {
    segment: "layouts",
    suffix: ".layout-meta.xml",
    memberType: "Layout",
    category: METADATA_CATEGORY.LAYOUT,
  },
  {
    segment: "flexipages",
    suffix: ".flexipage-meta.xml",
    memberType: "FlexiPage",
    category: METADATA_CATEGORY.LIGHTNING_PAGE,
  },
  {
    segment: "customMetadata",
    suffix: ".md-meta.xml",
    memberType: "CustomMetadata",
    category: METADATA_CATEGORY.CUSTOM_METADATA,
  },
  {
    segment: "labels",
    suffix: ".labels-meta.xml",
    memberType: "CustomLabels",
    category: METADATA_CATEGORY.CUSTOM_LABEL,
  },
  {
    segment: "workflows",
    suffix: ".workflow-meta.xml",
    memberType: "Workflow",
    category: METADATA_CATEGORY.WORKFLOW,
  },
  {
    segment: "approvalProcesses",
    suffix: ".approvalProcess-meta.xml",
    memberType: "ApprovalProcess",
    category: METADATA_CATEGORY.APPROVAL_PROCESS,
  },
  {
    // No dedicated category: the live generic extractor classifies tabs as
    // opaque too; the CustomTab rule parser is chosen by memberType.
    segment: "tabs",
    suffix: ".tab-meta.xml",
    memberType: "CustomTab",
    category: METADATA_CATEGORY.OPAQUE,
  },
  {
    segment: "duplicateRules",
    suffix: ".duplicateRule-meta.xml",
    memberType: "DuplicateRule",
    category: METADATA_CATEGORY.DUPLICATE_RULE,
  },
  {
    // Opaque node `LightningMessageChannel:<name>`, as the live extractor
    // makes: the target of LWC / Aura Lightning Message Service edges.
    segment: "messageChannels",
    suffix: ".messageChannel-meta.xml",
    memberType: "LightningMessageChannel",
    category: METADATA_CATEGORY.OPAQUE,
  },
];

/**
 * Agentforce / Industries / Data Cloud members. Most are flat
 * `<Name>.<type>-meta.xml` files; `bots`, `genAiFunctions` and
 * `genAiPlannerBundles` are folder-per-member in source format
 * (`bots/<Name>/<Name>.bot-meta.xml` + `v1.botVersion-meta.xml`,
 * `genAiFunctions/<Name>/<Name>.genAiFunction-meta.xml` + schema files,
 * `genAiPlannerBundles/<Name>/<Name>.genAiPlannerBundle`), so each spec is
 * read both as flat files in the folder and as one meta file per subfolder.
 * Only the XML file is read (never the folder's schema / input / output files).
 * All route to the same rule parsers as the live generic path.
 */
interface MdFolderSpec {
  segment: string;
  /** Meta-file suffixes (longest first); the member name is what precedes it. */
  suffixes: string[];
  memberType: string;
  category: MetadataCategory;
  /** A second member type living in the same subfolder (a bot's versions):
   *  named `<folder>.<file base>` like the Metadata API fullName. */
  child?: { suffix: string; memberType: string };
}

const FOLDER_SPECS: MdFolderSpec[] = [
  {
    segment: "bots",
    suffixes: [".bot-meta.xml"],
    memberType: "Bot",
    category: METADATA_CATEGORY.OPAQUE,
    child: { suffix: ".botVersion-meta.xml", memberType: "BotVersion" },
  },
  {
    segment: "genAiPlugins",
    suffixes: [".genAiPlugin-meta.xml"],
    memberType: "GenAiPlugin",
    category: METADATA_CATEGORY.GEN_AI_PLUGIN,
  },
  {
    segment: "genAiFunctions",
    suffixes: [".genAiFunction-meta.xml"],
    memberType: "GenAiFunction",
    category: METADATA_CATEGORY.OPAQUE,
  },
  {
    segment: "genAiPromptTemplates",
    suffixes: [".genAiPromptTemplate-meta.xml"],
    memberType: "GenAiPromptTemplate",
    category: METADATA_CATEGORY.OPAQUE,
  },
  {
    segment: "genAiPlannerBundles",
    suffixes: [".genAiPlannerBundle-meta.xml", ".genAiPlannerBundle"],
    memberType: "GenAiPlannerBundle",
    category: METADATA_CATEGORY.GEN_AI_PLANNER,
  },
  {
    segment: "genAiPlanners",
    suffixes: [".genAiPlanner-meta.xml"],
    memberType: "GenAiPlanner",
    category: METADATA_CATEGORY.GEN_AI_PLANNER,
  },
  {
    segment: "expressionSetDefinitions",
    suffixes: [".expressionSetDefinition-meta.xml"],
    memberType: "ExpressionSetDefinition",
    category: METADATA_CATEGORY.OPAQUE,
  },
  {
    segment: "decisionMatrixDefinitions",
    suffixes: [".decisionMatrixDefinition-meta.xml"],
    memberType: "DecisionMatrixDefinition",
    category: METADATA_CATEGORY.OPAQUE,
  },
  {
    segment: "dataStreamDefinitions",
    suffixes: [".dataStreamDefinition-meta.xml"],
    memberType: "DataStreamDefinition",
    category: METADATA_CATEGORY.OPAQUE,
  },
  {
    segment: "objectSourceTargetMaps",
    suffixes: [".objectSourceTargetMap-meta.xml"],
    memberType: "ObjectSourceTargetMap",
    category: METADATA_CATEGORY.OPAQUE,
  },
  {
    segment: "marketSegments",
    suffixes: [".marketSegment-meta.xml"],
    memberType: "MarketSegment",
    category: METADATA_CATEGORY.OPAQUE,
  },
];

const FOLDER_SPEC_SEGMENTS: ReadonlySet<string> = new Set(FOLDER_SPECS.map((s) => s.segment));

function metaNameOf(file: string, suffixes: string[]): string | null {
  for (const sfx of suffixes) {
    if (file.endsWith(sfx) && file.length > sfx.length) return file.slice(0, -sfx.length);
  }
  return null;
}

const BUNDLE_SPECS = [
  { segment: "lwc", memberType: "LightningComponentBundle", category: METADATA_CATEGORY.LWC },
  { segment: "aura", memberType: "AuraDefinitionBundle", category: METADATA_CATEGORY.AURA },
] as const;

function* walkPackage(pkgRoot: string, objectNames?: Set<string>): Iterable<IndexedMember> {
  // sfdx source-format usually has `main/default` (and sometimes other subroots).
  // We walk every subdirectory of pkgRoot (besides skip-list) looking for
  // canonical metadata folders.
  const queue: string[] = [pkgRoot];
  const mdRoots: string[] = [];
  while (queue.length > 0) {
    const dir = queue.shift();
    if (!dir) break;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    let foundMdFolder = false;
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      if (SKIP_DIR_NAMES.has(e.name)) continue;
      const full = path.join(dir, e.name);
      // Heuristic: a "main" or "default" subdir suggests we keep descending.
      if (e.name === "main" || e.name === "default") {
        queue.push(full);
        continue;
      }
      // Recognized leaf folders trigger handling at this level.
      if (
        e.name === "classes" ||
        e.name === "triggers" ||
        e.name === "lwc" ||
        e.name === "aura" ||
        e.name === "flows" ||
        e.name === "objects" ||
        e.name === "profiles" ||
        e.name === "permissionsets" ||
        e.name === "permissionsetgroups" ||
        e.name === "sharingRules" ||
        e.name === "namedCredentials" ||
        e.name === "externalServiceRegistrations" ||
        e.name === "pages" ||
        e.name === "components" ||
        e.name === "layouts" ||
        e.name === "flexipages" ||
        e.name === "customMetadata" ||
        e.name === "labels" ||
        e.name === "workflows" ||
        e.name === "approvalProcesses" ||
        e.name === "duplicateRules" ||
        e.name === "messageChannels" ||
        e.name === "tabs" ||
        FOLDER_SPEC_SEGMENTS.has(e.name)
      ) {
        foundMdFolder = true;
      }
    }
    if (foundMdFolder) {
      mdRoots.push(dir);
    }
  }
  if (mdRoots.length === 0) {
    // Treat pkgRoot itself as md root (e.g. tests passing in flat layout).
    mdRoots.push(pkgRoot);
  }

  for (const root of mdRoots) {
    // Walk leaf specs
    for (const spec of LEAF_SPECS) {
      const dir = path.join(root, spec.segment);
      if (!safeIsDir(dir)) continue;
      let files: fs.Dirent[];
      try {
        files = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const f of files) {
        if (!f.isFile()) continue;
        if (!f.name.endsWith(spec.suffix)) continue;
        const full = path.join(dir, f.name);
        const memberName = f.name.slice(0, -spec.suffix.length);
        yield indexed(`file://${full}`, spec.memberType, fileStamp(full), () => ({
          ref: makeRef(spec.category, spec.memberType, memberName, full),
          content: safeReadFile(full),
        }));
      }
    }

    // Agentforce / Industries / Data Cloud: flat meta files, or one meta file
    // per member folder (bots, genAiFunctions, genAiPlannerBundles).
    for (const spec of FOLDER_SPECS) {
      const segDir = path.join(root, spec.segment);
      if (!safeIsDir(segDir)) continue;
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(segDir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const ent of entries) {
        if (ent.isFile()) {
          const name = metaNameOf(ent.name, spec.suffixes);
          if (name === null) continue;
          const full = path.join(segDir, ent.name);
          yield indexed(`file://${full}`, spec.memberType, fileStamp(full), () => ({
            ref: makeRef(spec.category, spec.memberType, name, full),
            content: safeReadFile(full),
          }));
          continue;
        }
        if (!ent.isDirectory() || SKIP_DIR_NAMES.has(ent.name)) continue;
        const memberDir = path.join(segDir, ent.name);
        let files: fs.Dirent[];
        try {
          files = fs.readdirSync(memberDir, { withFileTypes: true });
        } catch {
          continue;
        }
        files.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
        let parentSeen = false;
        for (const f of files) {
          if (!f.isFile()) continue;
          const full = path.join(memberDir, f.name);
          if (!parentSeen && metaNameOf(f.name, spec.suffixes) !== null) {
            parentSeen = true;
            // The member is named for its folder (the Metadata API fullName).
            yield indexed(`file://${full}`, spec.memberType, fileStamp(full), () => ({
              ref: makeRef(spec.category, spec.memberType, ent.name, full),
              content: safeReadFile(full),
            }));
            continue;
          }
          if (spec.child) {
            const childBase = metaNameOf(f.name, [spec.child.suffix]);
            if (childBase !== null) {
              const childType = spec.child.memberType;
              yield indexed(`file://${full}`, childType, fileStamp(full), () => ({
                ref: makeRef(METADATA_CATEGORY.OPAQUE, childType, `${ent.name}.${childBase}`, full),
                content: safeReadFile(full),
              }));
            }
          }
        }
      }
    }

    // Component bundles (folder per bundle): LWC, and Aura (corecorr-08: Aura
    // bundles were recognised as a metadata folder but never yielded).
    for (const bundleSpec of BUNDLE_SPECS) {
      const bundlesDir = path.join(root, bundleSpec.segment);
      if (!safeIsDir(bundlesDir)) continue;
      let bundles: fs.Dirent[];
      try {
        bundles = fs.readdirSync(bundlesDir, { withFileTypes: true });
      } catch {
        bundles = [];
      }
      for (const b of bundles) {
        if (!b.isDirectory()) continue;
        if (SKIP_DIR_NAMES.has(b.name)) continue;
        const bundleDir = path.join(bundlesDir, b.name);
        let bundleFiles: fs.Dirent[];
        try {
          bundleFiles = fs.readdirSync(bundleDir, { withFileTypes: true });
        } catch {
          continue;
        }
        const names = bundleFiles.filter((bf) => bf.isFile()).map((bf) => bf.name);
        if (names.length === 0) continue;
        const fp = [...names]
          .sort()
          .map((n) => fileStamp(path.join(bundleDir, n), n))
          .join("|");
        yield indexed(`file://${bundleDir}`, bundleSpec.memberType, fp, () => {
          const files: Record<string, string> = {};
          for (const n of names) files[n] = safeReadFile(path.join(bundleDir, n));
          return {
            ref: makeRef(bundleSpec.category, bundleSpec.memberType, b.name, bundleDir),
            content: JSON.stringify({ bundleName: b.name, files }),
          };
        });
      }
    }

    // CustomObject bundles (folder per object)
    const objectsDir = path.join(root, "objects");
    if (safeIsDir(objectsDir)) {
      let objs: fs.Dirent[];
      try {
        objs = fs.readdirSync(objectsDir, { withFileTypes: true });
      } catch {
        objs = [];
      }
      for (const o of objs) {
        if (!o.isDirectory()) continue;
        objectNames?.add(o.name);
        const objDir = path.join(objectsDir, o.name);
        const objectXmlPath = path.join(objDir, `${o.name}.object-meta.xml`);
        const fieldStamps = dirStamps(path.join(objDir, "fields"), ".field-meta.xml");
        // Source trees often carry only `fields/` for standard / managed
        // objects (no `<O>.object-meta.xml`). Still yield the object as a
        // stub so its CustomField nodes exist; skip folders with neither.
        const stub = !fs.existsSync(objectXmlPath);
        if (stub && fieldStamps === "") continue;
        const fp = [
          stub ? "stub" : fileStamp(objectXmlPath),
          `fields=${fieldStamps}`,
          `recordTypes=${dirStamps(path.join(objDir, "recordTypes"), ".recordType-meta.xml")}`,
          `validationRules=${dirStamps(path.join(objDir, "validationRules"), ".validationRule-meta.xml")}`,
        ].join("\n");
        const uriPath = stub ? path.join(objDir, "fields") : objectXmlPath;
        yield indexed(`file://${uriPath}`, "CustomObject", fp, () => {
          const fields = readSubMap(path.join(objDir, "fields"), ".field-meta.xml");
          const objectXml = stub ? "" : safeReadFile(objectXmlPath);
          const recordTypes = readSubMap(path.join(objDir, "recordTypes"), ".recordType-meta.xml");
          const validationRules = readSubMap(
            path.join(objDir, "validationRules"),
            ".validationRule-meta.xml",
          );
          const content = JSON.stringify({
            apiName: o.name,
            objectXml,
            ...(stub ? { stub: true } : {}),
            fields,
            recordTypes,
            validationRules,
          });
          return {
            ref: makeRef(METADATA_CATEGORY.OBJECT, "CustomObject", o.name, uriPath),
            content,
          };
        });
      }
    }
  }
}

function readSubMap(dir: string, suffix: string): Record<string, string> {
  const out: Record<string, string> = {};
  if (!safeIsDir(dir)) return out;
  let files: fs.Dirent[];
  try {
    files = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const f of files) {
    if (!f.isFile()) continue;
    if (!f.name.endsWith(suffix)) continue;
    const apiName = f.name.slice(0, -suffix.length);
    out[apiName] = safeReadFile(path.join(dir, f.name));
  }
  return out;
}

function makeRef(
  category: MetadataCategory,
  memberType: string,
  memberName: string,
  absPath: string,
): MemberRef {
  return {
    category,
    memberType,
    memberName,
    lastModifiedAt: mtimeIso(absPath),
    sourceUri: `file://${absPath}`,
    namespace: null,
  };
}
