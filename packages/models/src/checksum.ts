import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { ErrorCode, SfgraphError } from "@sfgraph/shared";
import { MODEL_DATA_DIR } from "./paths.js";

export const E_MODEL_NOT_VENDORED = ErrorCode.E_MODEL_NOT_VENDORED;
export const E_MODEL_CHECKSUM_MISMATCH = ErrorCode.E_MODEL_CHECKSUM_MISMATCH;

export interface ChecksumManifest {
  model_id: string;
  files: Record<string, string>; // path-relative-to-data-dir -> sha256 hex
}

export async function readChecksumManifest(
  dir: string = MODEL_DATA_DIR,
): Promise<ChecksumManifest> {
  const path = join(dir, "CHECKSUM.json");
  if (!existsSync(path)) {
    throw new SfgraphError(
      ErrorCode.E_MODEL_NOT_VENDORED,
      `Vendored model checksum not found at ${path}. Run \`pnpm models:refresh\` to download.`,
    );
  }
  return JSON.parse(await readFile(path, "utf8")) as ChecksumManifest;
}

async function sha256File(p: string): Promise<string> {
  const buf = await readFile(p);
  return createHash("sha256").update(buf).digest("hex");
}

/**
 * Verify each file listed in CHECKSUM.json exists and matches its recorded
 * sha256. Throws SfgraphError with code E_MODEL_NOT_VENDORED if missing or
 * E_MODEL_CHECKSUM_MISMATCH on hash mismatch.
 */
export async function verifyVendoredModel(dir: string = MODEL_DATA_DIR): Promise<void> {
  const manifest = await readChecksumManifest(dir);
  const entries = Object.entries(manifest.files);
  if (entries.length === 0) {
    throw new SfgraphError(
      ErrorCode.E_MODEL_NOT_VENDORED,
      `Vendored model manifest is empty in ${dir}. Run \`pnpm models:refresh\`.`,
    );
  }
  for (const [rel, expected] of entries) {
    const p = join(dir, rel);
    if (!existsSync(p)) {
      throw new SfgraphError(
        ErrorCode.E_MODEL_NOT_VENDORED,
        `Vendored model file missing: ${rel}. Run \`pnpm models:refresh\`.`,
      );
    }
    const actual = await sha256File(p);
    if (actual !== expected) {
      throw new SfgraphError(
        ErrorCode.E_MODEL_CHECKSUM_MISMATCH,
        `Vendored model checksum mismatch for ${rel}: expected ${expected}, got ${actual}. Re-run \`pnpm models:refresh\`.`,
      );
    }
  }
}
