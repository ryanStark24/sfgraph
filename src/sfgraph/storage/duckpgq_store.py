"""DuckPGQStore — GraphStore stub for DuckDB/PGQ backend.

Validates the GraphStore Protocol boundary (GRAPH-04) by providing a concrete
class that fully implements the ABC without any real storage logic.

Not implemented in v1. All write/query methods raise NotImplementedError to
signal that this backend is reserved for a future release. The close() method
is intentionally a no-op (nothing to shut down).

This stub serves two architectural purposes:
1. Proves the GraphStore ABC can be implemented by a non-FalkorDB backend.
2. Acts as a safe default that fails loudly if accidentally used in production.
"""
from typing import Any

from sfgraph.storage.base import GraphStore


class DuckPGQStore(GraphStore):
    """Stub implementation of GraphStore using DuckDB/PGQ.

    All methods except close() raise NotImplementedError.
    close() is a no-op since there are no resources to release.
    """

    async def merge_node(
        self,
        label: str,
        key_props: dict[str, Any],
        all_props: dict[str, Any],
    ) -> str:
        """Not implemented: DuckPGQ backend is reserved for v2."""
        raise NotImplementedError(
            "DuckPGQStore.merge_node is not implemented. "
            "Use FalkorDBStore for v1 graph writes."
        )

    async def merge_edge(
        self,
        src_qualified_name: str,
        src_label: str,
        rel_type: str,
        dst_qualified_name: str,
        dst_label: str,
        props: dict[str, Any],
    ) -> None:
        """Not implemented: DuckPGQ backend is reserved for v2."""
        raise NotImplementedError(
            "DuckPGQStore.merge_edge is not implemented. "
            "Use FalkorDBStore for v1 graph writes."
        )

    async def query(
        self,
        cypher: str,
        params: dict[str, Any] | None = None,
    ) -> list[dict[str, Any]]:
        """Not implemented: DuckPGQ backend is reserved for v2."""
        raise NotImplementedError(
            "DuckPGQStore.query is not implemented. "
            "Use FalkorDBStore for v1 graph queries."
        )

    async def get_labels(self) -> list[str]:
        """Not implemented: DuckPGQ backend is reserved for v2."""
        raise NotImplementedError(
            "DuckPGQStore.get_labels is not implemented. "
            "Use FalkorDBStore for v1 schema inspection."
        )

    async def get_relationship_types(self) -> list[str]:
        """Not implemented: DuckPGQ backend is reserved for v2."""
        raise NotImplementedError(
            "DuckPGQStore.get_relationship_types is not implemented. "
            "Use FalkorDBStore for v1 schema inspection."
        )

    async def close(self) -> None:
        """No-op: DuckPGQStore holds no resources."""
        pass
