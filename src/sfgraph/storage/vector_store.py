# src/sfgraph/storage/vector_store.py
# Source: qdrant-client 1.17.1 docs + fastembed 0.8.0 docs
"""VectorStore — Qdrant-backed vector store with fastembed BAAI/bge-small-en-v1.5 embeddings.

Supports two modes:
  path=":memory:"    → in-memory Qdrant (tests only, no persistence)
  path="/abs/path"   → local file-backed Qdrant (dev / small orgs ≤20k vectors)
  url="http://..."   → Qdrant server (large orgs or production)

The path/url duality is intentional: it allows seamless migration from local to server
mode when an org exceeds Qdrant's ~20k-vector local ceiling (anticipated in Phase 4).

fastembed model: BAAI/bge-small-en-v1.5 (384 dimensions)
  - ~130MB ONNX model downloaded on first use, cached by fastembed automatically
  - Lazy-loaded to defer download until upsert/search is first called
"""
import logging
import hashlib
import os
from typing import Any

from qdrant_client import QdrantClient
from qdrant_client.models import (
    Distance,
    FieldCondition,
    Filter,
    MatchValue,
    PointIdsList,
    PointStruct,
    VectorParams,
)
from sfgraph.runtime_policy import network_allowed

logger = logging.getLogger(__name__)

COLLECTION_NAME = "source_chunks"
VECTOR_DIM = 384  # BAAI/bge-small-en-v1.5 output dimension


class VectorStore:
    """Qdrant-backed vector store with lazy fastembed embedding.

    Provides upsert and similarity-search operations over source code chunks.
    Each chunk is stored with its node_id and arbitrary payload (label, sourceFile, etc.).
    """

    def __init__(
        self,
        path: str | None = None,
        url: str | None = None,
    ) -> None:
        """
        Args:
            path: Local Qdrant storage path. Use ":memory:" for in-memory (tests only).
            url: Qdrant server URL (e.g. "http://localhost:6333").

        Raises:
            ValueError: If neither path nor url is provided.
        """
        if url:
            self._client = QdrantClient(url=url)
        elif path is not None:
            self._client = QdrantClient(path=path)
        else:
            raise ValueError("Either path or url must be provided to VectorStore")
        # Lazy-load embedder to defer model download until first upsert/search
        self._embedder = None

    def _get_embedder(self):
        """Return the fastembed TextEmbedding model, loading on first call."""
        if self._embedder is None:
            from fastembed import TextEmbedding
            if not network_allowed():
                # Hard privacy default: never fetch model artifacts over the network
                # unless explicitly allowed by the operator.
                os.environ.setdefault("HF_HUB_OFFLINE", "1")
                os.environ.setdefault("HUGGINGFACE_HUB_OFFLINE", "1")
                logger.info(
                    "Loading BAAI/bge-small-en-v1.5 embedding model in offline mode"
                )
                try:
                    self._embedder = TextEmbedding(
                        "BAAI/bge-small-en-v1.5",
                        local_files_only=True,
                    )
                except Exception as exc:  # noqa: BLE001
                    raise RuntimeError(
                        "Embeddings are configured to stay local-only. "
                        "Pre-cache the BAAI/bge-small-en-v1.5 model or set "
                        "SFGRAPH_ALLOW_NETWORK=1 to allow model download."
                    ) from exc
            else:
                logger.info(
                    "Loading BAAI/bge-small-en-v1.5 embedding model (first use — may download ~130MB)"
                )
                self._embedder = TextEmbedding("BAAI/bge-small-en-v1.5")
        return self._embedder

    @staticmethod
    def _point_id(node_id: str) -> int:
        """Deterministic point id derived from node_id."""
        digest = hashlib.sha256(node_id.encode("utf-8")).hexdigest()[:16]
        return int(digest, 16)

    async def initialize(self) -> None:
        """Create the source_chunks collection if it does not already exist.

        Idempotent: calling this multiple times is safe.
        """
        existing = [c.name for c in self._client.get_collections().collections]
        if COLLECTION_NAME not in existing:
            self._client.create_collection(
                collection_name=COLLECTION_NAME,
                vectors_config=VectorParams(size=VECTOR_DIM, distance=Distance.COSINE),
            )
            logger.info("Created Qdrant collection: %s", COLLECTION_NAME)
        else:
            logger.debug("Qdrant collection already exists: %s", COLLECTION_NAME)

    async def upsert(
        self,
        node_id: str,
        text: str,
        payload: dict[str, Any],
        project_scope: str | None = None,
    ) -> None:
        """Embed text and upsert a point for node_id.

        Args:
            node_id: Unique graph node identifier (e.g. "ApexClass:AccountService").
            text: Source code or text to embed.
            payload: Arbitrary metadata dict (label, sourceFile, etc.) stored alongside vector.
        """
        embedder = self._get_embedder()
        vectors = list(embedder.embed([text]))
        self._client.upsert(
            collection_name=COLLECTION_NAME,
            points=[
                PointStruct(
                    id=self._point_id(node_id),
                    vector=vectors[0].tolist(),
                    payload=payload | {"node_id": node_id, "project_scope": project_scope},
                )
            ],
        )
        logger.debug("Upserted vector for node_id=%s", node_id)

    async def search(
        self,
        query_text: str,
        limit: int = 10,
        project_scope: str | None = None,
    ) -> list[dict[str, Any]]:
        """Find the top-k most similar source code chunks to query_text.

        Args:
            query_text: Natural language or code query.
            limit: Maximum number of results to return.

        Returns:
            List of dicts with keys: node_id, score (float), payload (dict).
        """
        embedder = self._get_embedder()
        vectors = list(embedder.embed([query_text]))
        # Use query_points (qdrant-client >= 1.10; search() was removed in 1.17.x)
        response = self._client.query_points(
            collection_name=COLLECTION_NAME,
            query=vectors[0].tolist(),
            limit=limit,
            query_filter=Filter(
                must=[FieldCondition(key="project_scope", match=MatchValue(value=project_scope))]
            )
            if project_scope
            else None,
        )
        return [
            {
                "node_id": r.payload["node_id"],
                "score": float(r.score),
                "payload": r.payload,
            }
            for r in response.points
        ]

    async def delete_by_node_ids(self, node_ids: list[str]) -> int:
        """Delete points for the provided node_ids. Returns attempted delete count."""
        if not node_ids:
            return 0
        ids = [self._point_id(node_id) for node_id in node_ids]
        self._client.delete(
            collection_name=COLLECTION_NAME,
            points_selector=PointIdsList(points=ids),
            wait=True,
        )
        return len(ids)

    async def delete_by_project_scope(self, project_scope: str) -> int:
        """Delete all points for a project scope. Returns attempted delete count."""
        if not project_scope:
            return 0
        # Fetch ids first for deterministic return count. Large scopes can span
        # multiple pages, so keep scrolling until Qdrant reports exhaustion.
        point_ids: list[Any] = []
        offset = None
        while True:
            points, next_offset = self._client.scroll(
                collection_name=COLLECTION_NAME,
                scroll_filter=Filter(
                    must=[FieldCondition(key="project_scope", match=MatchValue(value=project_scope))]
                ),
                limit=10000,
                offset=offset,
                with_payload=False,
                with_vectors=False,
            )
            point_ids.extend(p.id for p in points)
            if next_offset is None:
                break
            offset = next_offset
        if not point_ids:
            return 0
        self._client.delete(
            collection_name=COLLECTION_NAME,
            points_selector=PointIdsList(points=point_ids),
            wait=True,
        )
        return len(point_ids)
