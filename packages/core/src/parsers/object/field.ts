import { XMLParser } from "fast-xml-parser";

const xmlParser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "@_" });

export interface ParsedField {
  apiName: string;
  type: string | null;
  formula: string | null;
  required: boolean;
  raw: any;
}

export function parseField(apiName: string, xml: string): ParsedField {
  const parsed = xmlParser.parse(xml) as any;
  const f = parsed?.CustomField ?? {};
  return {
    apiName: String(f.fullName ?? apiName),
    type: f.type ? String(f.type) : null,
    formula: f.formula ? String(f.formula) : null,
    required: f.required === true || f.required === "true",
    raw: f,
  };
}
