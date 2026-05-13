import { ALLOWED_FIELDS_BY_KIND, type EventKind } from "./event-schema.js";

const MAX_DEPTH = 10;

// Order matters: more specific patterns first.
const PATTERNS: Array<{ re: RegExp; replacement: string }> = [
  // Bearer tokens (Authorization header or bare)
  { re: /Authorization:\s*Bearer\s+[A-Za-z0-9._\-+/=]+/gi, replacement: "<bearer-token>" },
  { re: /\bBearer\s+[A-Za-z0-9._\-+/=]+/g, replacement: "<bearer-token>" },
  // Salesforce session ids: 00D org prefix + ! + body
  { re: /\b00D[0-9A-Za-z]{12,15}![A-Za-z0-9._\-+/=]+/g, replacement: "<sf-session>" },
  // Email addresses
  { re: /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g, replacement: "<email>" },
  // Salesforce hosts
  {
    re: /\b[a-zA-Z0-9-]+(?:\.[a-zA-Z0-9-]+)*\.(?:my\.salesforce\.com|lightning\.force\.com|visualforce\.com|cloudforce\.com|salesforce\.com|force\.com)\b/g,
    replacement: "<sf-host>",
  },
  // UUIDs
  {
    re: /\b[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\b/g,
    replacement: "<uuid>",
  },
  // Windows paths
  { re: /\b[A-Za-z]:\\[^\s"']*/g, replacement: "<path>" },
  // Unix absolute paths
  {
    re: /(?:\/Users|\/home|\/var|\/tmp|\/private|\/opt|\/etc)\/[^\s"':,]*/g,
    replacement: "<path>",
  },
  // Salesforce record ids - require known key prefixes to reduce false positives.
  // SF Id is 15 or 18 chars alphanumeric. We require a 3-char prefix from a known list.
  {
    re: /\b(?:001|003|005|006|00D|00e|00G|00Q|00T|00U|01p|a00|a01|a02|a03|a04|a05|a06|a07|a08|a09|0WO|0WP)[A-Za-z0-9]{12}(?:[A-Za-z0-9]{3})?\b/g,
    replacement: "<sf-id>",
  },
];

function scrubString(s: string): string {
  let out = s;
  for (const { re, replacement } of PATTERNS) {
    out = out.replace(re, replacement);
  }
  return out;
}

export class Sanitizer {
  sanitize(value: unknown): unknown {
    return this.walk(value, 0);
  }

  private walk(value: unknown, depth: number): unknown {
    if (depth > MAX_DEPTH) return "<max-depth>";
    if (value === null || value === undefined) return value;
    if (typeof value === "string") return scrubString(value);
    if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
      return value;
    }
    if (Array.isArray(value)) {
      return value.map((v) => this.walk(v, depth + 1));
    }
    if (typeof value === "object") {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        out[k] = this.walk(v, depth + 1);
      }
      return out;
    }
    return value;
  }

  /**
   * Strip event fields not in the allowlist for its kind, then sanitize remaining values.
   */
  sanitizeEvent(event: Record<string, unknown>): Record<string, unknown> {
    const kind = event["kind"];
    if (typeof kind !== "string" || !(kind in ALLOWED_FIELDS_BY_KIND)) {
      return {};
    }
    const allowed = ALLOWED_FIELDS_BY_KIND[kind as EventKind];
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(event)) {
      if (allowed.has(k)) {
        out[k] = this.walk(v, 0);
      }
    }
    return out;
  }
}
