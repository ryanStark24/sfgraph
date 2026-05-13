import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ErrorCode, SfgraphError } from "@ryanstark24/sfgraph-shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { verifyVendoredModel } from "../checksum.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "sfgraph-models-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("verifyVendoredModel", () => {
  it("throws E_MODEL_NOT_VENDORED when CHECKSUM.json is missing", async () => {
    await expect(verifyVendoredModel(dir)).rejects.toMatchObject({
      code: ErrorCode.E_MODEL_NOT_VENDORED,
    });
  });

  it("throws E_MODEL_CHECKSUM_MISMATCH when a file's hash does not match", async () => {
    const payload = Buffer.from("actual content");
    writeFileSync(join(dir, "a.bin"), payload);
    // wrong expected hash:
    writeFileSync(
      join(dir, "CHECKSUM.json"),
      JSON.stringify({
        model_id: "test",
        files: { "a.bin": "0".repeat(64) },
      }),
    );
    await expect(verifyVendoredModel(dir)).rejects.toMatchObject({
      code: ErrorCode.E_MODEL_CHECKSUM_MISMATCH,
    });
  });

  it("succeeds when every file matches its recorded hash", async () => {
    const payload = Buffer.from("real bytes");
    writeFileSync(join(dir, "a.bin"), payload);
    const hash = createHash("sha256").update(payload).digest("hex");
    writeFileSync(
      join(dir, "CHECKSUM.json"),
      JSON.stringify({ model_id: "test", files: { "a.bin": hash } }),
    );
    await expect(verifyVendoredModel(dir)).resolves.toBeUndefined();
  });

  it("E_MODEL_NOT_VENDORED is raised as a SfgraphError instance", async () => {
    try {
      await verifyVendoredModel(dir);
    } catch (err) {
      expect(err).toBeInstanceOf(SfgraphError);
      expect((err as SfgraphError).code).toBe(ErrorCode.E_MODEL_NOT_VENDORED);
      return;
    }
    throw new Error("expected verifyVendoredModel to throw");
  });
});

describe("EmbedderHandle shape", () => {
  it("a fake handle satisfies the interface contract (dim=384)", async () => {
    const fake = {
      modelId: "Xenova/all-MiniLM-L6-v2",
      dim: 384,
      embed: async (texts: string[]) => texts.map(() => new Float32Array(384)),
      close: async () => {},
    };
    expect(fake.dim).toBe(384);
    const out = await fake.embed(["hello"]);
    expect(out[0]?.length).toBe(384);
  });
});
