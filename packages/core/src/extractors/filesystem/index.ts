import * as fs from "node:fs";
import * as path from "node:path";
import { METADATA_CATEGORY, type MetadataCategory } from "../../domain/metadata-category.js";
import type { MemberRef, MetadataSource, RawMember } from "../interfaces/metadata-source.js";

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

  async *iter(): AsyncIterable<RawMember> {
    for (const pkg of this.packageDirs) {
      const pkgRoot = path.resolve(this.rootDir, pkg);
      if (!safeIsDir(pkgRoot)) continue;
      yield* walkPackage(pkgRoot);
    }
  }
}

function safeIsDir(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function safeReadFile(p: string): string {
  try {
    return fs.readFileSync(p, "utf8");
  } catch {
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
    segment: "duplicateRules",
    suffix: ".duplicateRule-meta.xml",
    memberType: "DuplicateRule",
    category: METADATA_CATEGORY.DUPLICATE_RULE,
  },
];

async function* walkPackage(pkgRoot: string): AsyncIterable<RawMember> {
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
        e.name === "duplicateRules"
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
        yield {
          ref: makeRef(spec.category, spec.memberType, memberName, full),
          content: safeReadFile(full),
        };
      }
    }

    // LWC bundles
    const lwcDir = path.join(root, "lwc");
    if (safeIsDir(lwcDir)) {
      let bundles: fs.Dirent[];
      try {
        bundles = fs.readdirSync(lwcDir, { withFileTypes: true });
      } catch {
        bundles = [];
      }
      for (const b of bundles) {
        if (!b.isDirectory()) continue;
        if (SKIP_DIR_NAMES.has(b.name)) continue;
        const bundleDir = path.join(lwcDir, b.name);
        const files: Record<string, string> = {};
        let bundleFiles: fs.Dirent[];
        try {
          bundleFiles = fs.readdirSync(bundleDir, { withFileTypes: true });
        } catch {
          continue;
        }
        for (const bf of bundleFiles) {
          if (!bf.isFile()) continue;
          const fp = path.join(bundleDir, bf.name);
          files[bf.name] = safeReadFile(fp);
        }
        if (Object.keys(files).length === 0) continue;
        yield {
          ref: makeRef(METADATA_CATEGORY.LWC, "LightningComponentBundle", b.name, bundleDir),
          content: JSON.stringify({ bundleName: b.name, files }),
        };
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
        const objDir = path.join(objectsDir, o.name);
        const objectXmlPath = path.join(objDir, `${o.name}.object-meta.xml`);
        if (!fs.existsSync(objectXmlPath)) continue;
        const objectXml = safeReadFile(objectXmlPath);
        const fields = readSubMap(path.join(objDir, "fields"), ".field-meta.xml");
        const recordTypes = readSubMap(path.join(objDir, "recordTypes"), ".recordType-meta.xml");
        const validationRules = readSubMap(
          path.join(objDir, "validationRules"),
          ".validationRule-meta.xml",
        );
        const content = JSON.stringify({
          apiName: o.name,
          objectXml,
          fields,
          recordTypes,
          validationRules,
        });
        yield {
          ref: makeRef(METADATA_CATEGORY.OBJECT, "CustomObject", o.name, objectXmlPath),
          content,
        };
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
