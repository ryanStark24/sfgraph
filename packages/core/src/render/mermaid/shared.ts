export const LABEL_COLORS: Record<string, string> = {
  ApexClass: "#4a90e2",
  ApexTrigger: "#2c6fb8",
  ApexMethod: "#4a90e2",
  LWC: "#f5a623",
  LightningComponentBundle: "#f5a623",
  AuraDefinitionBundle: "#f5a623",
  Flow: "#7ed321",
  CustomObject: "#9013fe",
  CustomField: "#bd10e0",
  Profile: "#d0021b",
  PermissionSet: "#d0021b",
  NamedCredential: "#50e3c2",
  PlatformEventChannel: "#50e3c2",
  Default: "#9b9b9b",
};

export function colorForLabel(label: string): string {
  return LABEL_COLORS[label] ?? LABEL_COLORS.Default ?? "#9b9b9b";
}

export interface CentralityNode {
  qualifiedName: string;
  label: string;
}

export interface CentralityEdge {
  srcQualifiedName: string;
  dstQualifiedName: string;
}

export interface TruncateResult<N> {
  kept: N[];
  truncated: number;
}

/**
 * Keep the most central nodes by degree (in+out). If nodes.length <= cap, no truncation.
 */
export function truncateByCentrality<N extends CentralityNode>(
  nodes: N[],
  edges: CentralityEdge[],
  cap = 40,
): TruncateResult<N> {
  if (nodes.length <= cap) return { kept: nodes, truncated: 0 };
  const degree = new Map<string, number>();
  for (const e of edges) {
    degree.set(e.srcQualifiedName, (degree.get(e.srcQualifiedName) ?? 0) + 1);
    degree.set(e.dstQualifiedName, (degree.get(e.dstQualifiedName) ?? 0) + 1);
  }
  const sorted = [...nodes].sort(
    (a, b) => (degree.get(b.qualifiedName) ?? 0) - (degree.get(a.qualifiedName) ?? 0),
  );
  return { kept: sorted.slice(0, cap), truncated: nodes.length - cap };
}

export function sanitizeLabel(name: string): string {
  let s = name;
  if (s.length > 30) s = `${s.slice(0, 27)}…`;
  s = s.replace(/"/g, "'").replace(/[\[\]\(\)]/g, "_");
  return s;
}

export function mermaidId(qname: string): string {
  return qname.replace(/[^A-Za-z0-9_]/g, "_");
}

export function fenceLabel(name: string): string {
  return `"${sanitizeLabel(name)}"`;
}
