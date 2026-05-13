# @sfgraph/models

Vendored embedding model files. ONNX weights are stored under `data/` via Git LFS (see root `.gitattributes`).

Phase 0: package shell only. `loadEmbeddingModel()` throws `not implemented in Phase 0`. The real loader and the all-MiniLM-L6-v2 quantized ONNX are wired in Phase 5.
