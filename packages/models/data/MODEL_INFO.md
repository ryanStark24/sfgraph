# Vendored Embedding Model

sfgraph ships a quantized ONNX build of `Xenova/all-MiniLM-L6-v2` (384-dim
sentence embeddings) so retrieval works fully offline.

## Source

- HF repo: https://huggingface.co/Xenova/all-MiniLM-L6-v2
- Files we pull (all under `Xenova/all-MiniLM-L6-v2/`):
  - `onnx/model_quantized.onnx`
  - `config.json`
  - `tokenizer.json`
  - `tokenizer_config.json`
  - `special_tokens_map.json`

The `Xenova/all-MiniLM-L6-v2/` directory layout matches what
`@xenova/transformers` expects when `env.localModelPath` points at this
`data/` directory.

## Refresh procedure

1. `pnpm models:refresh` — downloads all files from HF into `packages/models/data/`.
2. The script regenerates `CHECKSUM.json` with fresh sha256 entries for every
   file.
3. Commit only `CHECKSUM.json` + `MODEL_INFO.md` as plain text. The `.onnx`
   file is tracked via Git LFS (see root `.gitattributes`).
4. Verify with `pnpm --filter @sfgraph/models test` — the integration test
   gated on `MODELS_VENDORED=1` exercises a real embedding round-trip.

## Why vendored?

- Zero network egress at runtime (privacy commitment).
- Deterministic embeddings across user machines.
- No surprise model downloads in CI.

If `CHECKSUM.json` is empty or any listed file is missing, the loader throws
`SfgraphError` with code `E_MODEL_NOT_VENDORED` and instructs the user to run
`pnpm models:refresh`.
