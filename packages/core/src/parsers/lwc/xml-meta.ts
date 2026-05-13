import { XMLParser } from "fast-xml-parser";

const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "@_" });

export function extractMetaXml(xml: string): Record<string, unknown> {
  try {
    const parsed = parser.parse(xml) as any;
    const root = parsed?.LightningComponentBundle ?? {};
    return {
      apiVersion: root.apiVersion ?? null,
      isExposed: root.isExposed ?? null,
      targets: root.targets?.target ? toArray(root.targets.target) : [],
      masterLabel: root.masterLabel ?? null,
    };
  } catch {
    return {};
  }
}

function toArray<T>(v: T | T[]): T[] {
  return Array.isArray(v) ? v : [v];
}
