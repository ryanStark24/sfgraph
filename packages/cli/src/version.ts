import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

export function getCliVersion(): string {
  // dist/version.js → ../package.json
  const candidates = [join(here, "..", "package.json"), join(here, "..", "..", "package.json")];
  for (const p of candidates) {
    try {
      const pkg = JSON.parse(readFileSync(p, "utf8")) as { version?: string };
      if (pkg.version) return pkg.version;
    } catch {
      // try next
    }
  }
  return "0.0.0";
}
