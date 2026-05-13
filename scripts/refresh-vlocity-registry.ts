#!/usr/bin/env tsx
/**
 * Refresh the vendored Vlocity QueryDefinitions.yaml registry.
 *
 * Pulls from vlocityinc/vlocity_build master and rewrites the vendored copy
 * under packages/core/src/extractors/live-org/vlocity/. The header is
 * regenerated on every run.
 */

import { writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const dest = join(
  here,
  "..",
  "packages/core/src/extractors/live-org/vlocity/query-definitions.yml",
);

const url =
  "https://raw.githubusercontent.com/vlocityinc/vlocity_build/master/dataPacksJobs/QueryDefinitions.yaml";

const res = await fetch(url);
if (!res.ok) throw new Error(`Failed: ${res.status}`);
const body = await res.text();
const header = `# Vendored from vlocityinc/vlocity_build (MIT) on ${new Date().toISOString()}\n# Upstream: ${url}\n# Do not edit by hand. Re-sync via scripts/refresh-vlocity-registry.ts\n\n`;
await writeFile(dest, header + body, "utf8");
console.log(`Wrote ${dest}`);
