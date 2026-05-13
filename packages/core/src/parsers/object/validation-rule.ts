import { XMLParser } from "fast-xml-parser";

const xmlParser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "@_" });

export interface ParsedValidationRule {
  apiName: string;
  active: boolean;
  errorConditionFormula: string | null;
  errorMessage: string | null;
}

export function parseValidationRule(apiName: string, xml: string): ParsedValidationRule {
  const parsed = xmlParser.parse(xml) as any;
  const r = parsed?.ValidationRule ?? {};
  return {
    apiName: String(r.fullName ?? apiName),
    active: r.active === true || r.active === "true",
    errorConditionFormula: r.errorConditionFormula ? String(r.errorConditionFormula) : null,
    errorMessage: r.errorMessage ? String(r.errorMessage) : null,
  };
}
