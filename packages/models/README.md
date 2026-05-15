# @ryanstark24/sfgraph-models

Vendored embedding model for sfgraph. Ships an ONNX-quantised
[all-MiniLM-L6-v2](https://huggingface.co/Xenova/all-MiniLM-L6-v2) (384-dim)
under `data/` via Git LFS — see the root `.gitattributes`. Used by
`@ryanstark24/sfgraph-core` to generate node embeddings for semantic search.

## Install

The `.onnx` and tokenizer files are tracked with Git LFS. After cloning:

```bash
git lfs install
git lfs pull
```

Without this the files on disk are 134-byte LFS pointers and `loadEmbedder()`
will fail its SHA-256 checksum verification.

`@xenova/transformers` is an `optionalDependency` — installing this package
without it disables embedding generation but does not error.

## Usage

```ts
import { loadEmbedder } from "@ryanstark24/sfgraph-models";

const embedder = await loadEmbedder();
const [vec] = await embedder.embed(["account.status field accessor"]);
// vec is a Float32Array of length 384
await embedder.close();
```

### Bring your own model

Override the vendored model via either options or env vars:

| Option      | Env var                    | Default                   |
| ----------- | -------------------------- | ------------------------- |
| `modelPath` | `SFGRAPH_EMBED_MODEL_PATH` | `<package>/data`          |
| `modelId`   | `SFGRAPH_EMBED_MODEL_ID`   | `Xenova/all-MiniLM-L6-v2` |
| `dim`       | `SFGRAPH_EMBED_MODEL_DIM`  | `384`                     |
| `quantized` | —                          | `true`                    |

The model directory layout must match what `transformers.js` expects:
`<modelPath>/<modelId>/onnx/model.onnx` (and the matching tokenizer files).

## Data files

`data/MODEL_INFO.md` documents the exact origin and SHA-256 of every file
checked in under `data/`. Updating the vendored model requires regenerating
`src/checksum.ts` — see that file for the verification flow.
