import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

/** The server package version, read from package.json (dist/version.js and src/version.ts both sit one level below it). */
export function getServerVersion(): string {
  const candidates = [join(here, "..", "package.json"), join(here, "..", "..", "package.json")];
  for (const p of candidates) {
    try {
      const pkg = JSON.parse(readFileSync(p, "utf8")) as { name?: string; version?: string };
      if (pkg.name === "@ryanstark24/sfgraph-server" && pkg.version) return pkg.version;
    } catch {
      // try next
    }
  }
  return "0.0.0";
}
