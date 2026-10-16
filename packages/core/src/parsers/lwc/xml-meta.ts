import { XMLParser } from "fast-xml-parser";

const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "@_" });

export function extractMetaXml(xml: string): Record<string, unknown> {
  try {
    const parsed = parser.parse(xml) as any;
    const root = parsed?.LightningComponentBundle ?? {};
    const out: Record<string, unknown> = {
      apiVersion: root.apiVersion ?? null,
      isExposed: root.isExposed ?? null,
      targets: root.targets?.target ? toArray(root.targets.target) : [],
      masterLabel: root.masterLabel ?? null,
    };
    // `<targetConfig><objects><object>Account</object></objects>` pins the
    // record pages the component may be placed on: static object context.
    const objects = new Set<string>();
    const configs = root.targetConfigs?.targetConfig;
    for (const cfg of configs ? toArray(configs) : []) {
      const objs = (cfg as any)?.objects?.object;
      for (const o of objs ? toArray(objs) : []) {
        const name = typeof o === "string" ? o.trim() : String((o as any)?.["#text"] ?? "").trim();
        if (name) objects.add(name);
      }
    }
    if (objects.size > 0) out.targetObjects = [...objects].sort();
    return out;
  } catch {
    return {};
  }
}

function toArray<T>(v: T | T[]): T[] {
  return Array.isArray(v) ? v : [v];
}
