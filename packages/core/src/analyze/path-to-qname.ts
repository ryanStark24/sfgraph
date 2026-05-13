import { type QualifiedName, asQualifiedName } from "@sfgraph/shared";

export function pathToQualifiedName(p: string): QualifiedName | null {
  const norm = p.replace(/\\/g, "/");
  // ApexClass
  let m = norm.match(/classes\/([^/]+)\.cls(-meta\.xml)?$/);
  if (m) return asQualifiedName(`ApexClass:${m[1]}`);
  m = norm.match(/triggers\/([^/]+)\.trigger(-meta\.xml)?$/);
  if (m) return asQualifiedName(`ApexTrigger:${m[1]}`);
  // LWC: lwc/<bundle>/...
  m = norm.match(/lwc\/([^/]+)\/.*$/);
  if (m) return asQualifiedName(`LWC:${m[1]}`);
  // Flow
  m = norm.match(/flows\/([^/]+)\.flow(-meta\.xml)?$/);
  if (m) return asQualifiedName(`Flow:${m[1]}`);
  // CustomField: objects/<obj>/fields/<field>.field-meta.xml
  m = norm.match(/objects\/([^/]+)\/fields\/([^/]+)\.field-meta\.xml$/);
  if (m) return asQualifiedName(`CustomField:${m[1]}.${m[2]}`);
  // CustomObject: objects/<obj>/<obj>.object-meta.xml or objects/<obj>.object
  m = norm.match(/objects\/([^/]+)\/\1\.object-meta\.xml$/);
  if (m) return asQualifiedName(`CustomObject:${m[1]}`);
  m = norm.match(/objects\/([^/]+)\.object$/);
  if (m) return asQualifiedName(`CustomObject:${m[1]}`);
  return null;
}
