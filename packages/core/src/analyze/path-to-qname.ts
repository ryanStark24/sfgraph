import { type QualifiedName, asQualifiedName } from "@ryanstark24/sfgraph-shared";

/**
 * Single-file source-format metadata the filesystem extractor yields as one
 * member named after the file (`<Name>.<suffix>-meta.xml`; ApexPage and
 * ApexComponent content files are `<Name>.page` / `<Name>.component`), and
 * whose parser names its node `<Label>:<Name>` (parsers/rules/*.yml
 * `${record.name}`, the Flow parser). Multi-item files (custom labels,
 * sharing rules, workflows) are not here: their items are resolved through
 * the graph's member index.
 */
const SUFFIX_LABEL: Readonly<Record<string, string>> = {
  flow: "Flow",
  page: "ApexPage",
  component: "ApexComponent",
  layout: "Layout",
  flexipage: "FlexiPage",
  permissionset: "PermissionSet",
  permissionsetgroup: "PermissionSetGroup",
  profile: "Profile",
  tab: "CustomTab",
  namedCredential: "NamedCredential",
  externalServiceRegistration: "ExternalServiceRegistration",
  approvalProcess: "ApprovalProcess",
  duplicateRule: "DuplicateRule",
  md: "CustomMetadataRecord",
};

/**
 * The qualified name a changed source path stands for, from the SFDX /
 * MDAPI file grammar alone (no graph): Apex classes and triggers, LWC and
 * Aura bundles (any file of the bundle), fields, record types and validation
 * rules (`objects/<O>/<kind>/<N>`), objects, and the single-file types of
 * `SUFFIX_LABEL`. Null for anything else (a multi-item file such as custom
 * labels, a DataPack, an unparsed type); callers resolve those through the
 * graph's member index (diff-seeds.ts) or report them unmapped.
 */
export function pathToQualifiedName(p: string): QualifiedName | null {
  const norm = p.replace(/\\/g, "/");
  let m = norm.match(/(?:^|\/)classes\/([^/]+)\.cls(-meta\.xml)?$/);
  if (m) return asQualifiedName(`ApexClass:${m[1]}`);
  m = norm.match(/(?:^|\/)triggers\/([^/]+)\.trigger(-meta\.xml)?$/);
  if (m) return asQualifiedName(`ApexTrigger:${m[1]}`);
  m = norm.match(/(?:^|\/)lwc\/([^/]+)\/.+$/);
  if (m && !m[1]?.startsWith(".")) return asQualifiedName(`LWC:${m[1]}`);
  m = norm.match(/(?:^|\/)aura\/([^/]+)\/.+$/);
  if (m && !m[1]?.startsWith(".")) return asQualifiedName(`AuraComponent:${m[1]}`);
  m = norm.match(/(?:^|\/)objects\/([^/]+)\/fields\/([^/]+)\.field-meta\.xml$/);
  if (m) return asQualifiedName(`CustomField:${m[1]}.${m[2]}`);
  m = norm.match(/(?:^|\/)objects\/([^/]+)\/recordTypes\/([^/]+)\.recordType-meta\.xml$/);
  if (m) return asQualifiedName(`RecordType:${m[1]}.${m[2]}`);
  m = norm.match(/(?:^|\/)objects\/([^/]+)\/validationRules\/([^/]+)\.validationRule-meta\.xml$/);
  if (m) return asQualifiedName(`ValidationRule:${m[1]}.${m[2]}`);
  m = norm.match(/(?:^|\/)objects\/([^/]+)\/\1\.object-meta\.xml$/);
  if (m) return asQualifiedName(`CustomObject:${m[1]}`);
  m = norm.match(/(?:^|\/)objects\/([^/]+)\.object$/);
  if (m) return asQualifiedName(`CustomObject:${m[1]}`);
  m =
    norm.match(/(?:^|\/)([^/]+)\.([A-Za-z]+)-meta\.xml$/) ??
    norm.match(/(?:^|\/)([^/]+)\.(page|component|flow)$/);
  if (m) {
    const label = SUFFIX_LABEL[m[2] ?? ""];
    if (label) return asQualifiedName(`${label}:${m[1]}`);
  }
  return null;
}
