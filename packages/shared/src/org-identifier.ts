import path from "node:path";
import { ErrorCode, SfgraphError } from "./errors.js";

/**
 * Validate a user-supplied org identifier (alias OR Salesforce 15/18-char ID).
 *
 * Accepts:
 *   - 15-char or 18-char alphanumeric Salesforce IDs.
 *   - Aliases matching `^[A-Za-z][A-Za-z0-9_-]{0,63}$` (must start with a
 *     letter, only alphanumerics / `_` / `-`, up to 64 chars total).
 *
 * Rejects (throws `SfgraphError(E_INVALID_ORG_IDENTIFIER, ...)`):
 *   - empty / non-string
 *   - control chars (incl. NUL `\0`)
 *   - path-traversal: `/`, `\\`, `..`, leading `.`
 *   - Windows-reserved names (con, prn, aux, nul, com1-9, lpt1-9)
 *   - anything longer than 64 chars
 */

const ID_15 = /^[A-Za-z0-9]{15}$/;
const ID_18 = /^[A-Za-z0-9]{18}$/;
const ALIAS_RE = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
const WINDOWS_RESERVED = new Set([
  "con",
  "prn",
  "aux",
  "nul",
  "com1",
  "com2",
  "com3",
  "com4",
  "com5",
  "com6",
  "com7",
  "com8",
  "com9",
  "lpt1",
  "lpt2",
  "lpt3",
  "lpt4",
  "lpt5",
  "lpt6",
  "lpt7",
  "lpt8",
  "lpt9",
]);

function reject(value: unknown, reason: string): never {
  throw new SfgraphError(
    ErrorCode.E_INVALID_ORG_IDENTIFIER,
    `invalid org identifier (${reason}): ${JSON.stringify(value)}`,
  );
}

/**
 * Validate an org identifier string. Returns the (trimmed) input unchanged when
 * valid; throws `SfgraphError(E_INVALID_ORG_IDENTIFIER, ...)` otherwise.
 */
export function validateOrgIdentifier(input: unknown): string {
  if (typeof input !== "string") reject(input, "not a string");
  const s = input as string;
  if (s.length === 0) reject(s, "empty");
  if (s.length > 64) reject(s, "too long");
  // control chars (incl NUL) and explicit traversal markers
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x20 || c === 0x7f) reject(s, "control character");
  }
  if (s.includes("/") || s.includes("\\")) reject(s, "path separator");
  if (s.includes("..")) reject(s, "parent-directory traversal");
  if (s.startsWith(".")) reject(s, "leading dot");
  if (WINDOWS_RESERVED.has(s.toLowerCase())) reject(s, "reserved name");
  if (ID_15.test(s) || ID_18.test(s)) return s;
  if (ALIAS_RE.test(s)) return s;
  reject(s, "not a 15/18-char SF id and not a valid alias");
}

/**
 * Build a sqlite path for `<dataDir>/<orgId>.sqlite`, after asserting the
 * identifier is well-formed AND that the resolved path is contained within
 * `dataDir`. Throws `SfgraphError(E_INVALID_ORG_IDENTIFIER, ...)` otherwise.
 */
export function safeOrgDbPath(dataDir: string, orgIdOrAlias: string): string {
  const id = validateOrgIdentifier(orgIdOrAlias);
  const candidate = path.resolve(dataDir, `${id}.sqlite`);
  const root = path.resolve(dataDir);
  const rel = path.relative(root, candidate);
  if (rel.startsWith("..") || path.isAbsolute(rel) || rel.includes(path.sep)) {
    reject(orgIdOrAlias, "resolves outside data dir");
  }
  return candidate;
}
