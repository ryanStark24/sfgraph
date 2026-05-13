import { XMLParser } from "fast-xml-parser";

const xmlParser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "@_" });

export interface ParsedRecordType {
  apiName: string;
  label: string | null;
  active: boolean;
}

export function parseRecordType(apiName: string, xml: string): ParsedRecordType {
  const parsed = xmlParser.parse(xml) as any;
  const r = parsed?.RecordType ?? {};
  return {
    apiName: String(r.fullName ?? apiName),
    label: r.label ? String(r.label) : null,
    active: r.active === true || r.active === "true",
  };
}
