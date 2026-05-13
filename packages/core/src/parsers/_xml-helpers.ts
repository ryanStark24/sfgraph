import { createHash } from "node:crypto";
import { XMLParser } from "fast-xml-parser";

export const xmlParser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "@_" });

export function toArr<T>(v: T | T[] | undefined | null): T[] {
  if (v === undefined || v === null) return [];
  return Array.isArray(v) ? v : [v];
}

export function sha256(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}
