import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { embedModelFingerprint, resolveEmbedModelFile } from "../embed.js";

/**
 * Ruling (b): the embedding cache is keyed by the model FILE's sha256, not
 * just the model id, so swapping the weights under the same id can never
 * serve vectors computed by the old weights.
 */
let dir: string;
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "sfg-modelfp-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function writeModel(content: string): string {
  const file = path.join(dir, "Org", "my-model", "onnx", "model_quantized.onnx");
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, content);
  return file;
}

describe("embedding model fingerprint", () => {
  it("resolves <modelPath>/<modelId>/onnx/model_quantized.onnx", async () => {
    const file = writeModel("weights v1");
    expect(await resolveEmbedModelFile({ modelPath: dir, modelId: "Org/my-model" })).toBe(file);
  });

  it("is the sha256 of the model file and changes when the weights change", async () => {
    writeModel("weights v1");
    const opts = { modelPath: dir, modelId: "Org/my-model" };
    const a = await embedModelFingerprint(opts);
    expect(a).toBe(createHash("sha256").update("weights v1").digest("hex"));
    writeModel("weights v2, same id");
    const b = await embedModelFingerprint(opts);
    expect(b).toBe(createHash("sha256").update("weights v2, same id").digest("hex"));
    expect(b).not.toBe(a);
  });

  it("is null when the model file is missing", async () => {
    expect(await embedModelFingerprint({ modelPath: dir, modelId: "Org/none" })).toBeNull();
  });

  it("finds the vendored default model", async () => {
    const fp = await embedModelFingerprint();
    // The vendored models package is a workspace dependency of core.
    expect(fp).toMatch(/^[0-9a-f]{64}$/);
  });
});
