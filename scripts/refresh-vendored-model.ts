#!/usr/bin/env tsx
/**
 * Refresh the vendored MiniLM embedding model.
 *
 * Downloads the file set listed in MODEL_FILES from Hugging Face,
 * writes them under packages/models/data/, and regenerates CHECKSUM.json.
 *
 * DO NOT run from CI. This downloads ~30MB and is a maintainer-only command.
 */

import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(HERE, "..", "packages", "models", "data");
const REPO = "Xenova/all-MiniLM-L6-v2";
const BASE = `https://huggingface.co/${REPO}/resolve/main`;

const MODEL_FILES: string[] = [
  "config.json",
  "tokenizer.json",
  "tokenizer_config.json",
  "special_tokens_map.json",
  "onnx/model_quantized.onnx",
];

async function fetchToBuffer(url: string): Promise<Buffer> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`fetch ${url} -> ${res.status}`);
  const ab = await res.arrayBuffer();
  return Buffer.from(ab);
}

function sha256Hex(buf: Buffer): string {
  return createHash("sha256").update(buf).digest("hex");
}

async function main(): Promise<void> {
  await mkdir(DATA_DIR, { recursive: true });
  const checksums: Record<string, string> = {};
  for (const rel of MODEL_FILES) {
    const url = `${BASE}/${rel}`;
    const dest = join(DATA_DIR, REPO, rel);
    const destDir = dirname(dest);
    await mkdir(destDir, { recursive: true });
    console.log(`[refresh] ${rel}`);
    const buf = await fetchToBuffer(url);
    await writeFile(dest, buf);
    checksums[`${REPO}/${rel}`] = sha256Hex(buf);
  }
  const manifest = {
    model_id: REPO,
    files: checksums,
  };
  await writeFile(
    join(DATA_DIR, "CHECKSUM.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
    "utf8",
  );
  console.log(`[refresh] CHECKSUM.json written with ${Object.keys(checksums).length} entries`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
