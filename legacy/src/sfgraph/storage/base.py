"""GraphStore Abstract Base Class.

Defines the contract that every graph storage backend must implement.
No implementation details, no backend-specific imports.

Purpose: All ingestion and query code depends on GraphStore, never on a
concrete backend. This enforces the Protocol boundary at the Python type
system level and enables backend substitution without changing any caller.
without changing any caller.
"""
from abc import ABC, abstractmethod
from typing import Any


class GraphStore(ABC):
    """Abstract base class for all graph storage backends.

    All methods are async to support both in-process and networked backends
    without requiring callers to know which they are using.
    """

    @abstractmethod
    async def merge_node(
        self,
        label: str,
        key_props: dict[str, Any],
        all_props: dict[str, Any],
    ) -> str:
        """Upsert a node and return its qualified name.

        Args:
            label: The node label (e.g. "ApexClass", "CustomField").
            key_props: Properties that uniquely identify this node (used for MERGE match).
            all_props: All properties to set on the node after match/create.

        Returns:
            The qualified name (unique string identifier) for this node.
        """
        ...

    @abstractmethod
    async def merge_edge(
        self,
        src_qualified_name: str,
        src_label: str,
        rel_type: str,
        dst_qualified_name: str,
        dst_label: str,
        props: dict[str, Any],
    ) -> None:
        """Upsert a directed relationship between two nodes.

        Args:
            src_qualified_name: Unique identifier for the source node.
            src_label: Label of the source node.
            rel_type: Relationship type (e.g. "CALLS", "READS_FIELD").
            dst_qualified_name: Unique identifier for the destination node.
            dst_label: Label of the destination node.
            props: Properties to set on the relationship.
        """
        ...

    @abstractmethod
    async def merge_nodes_batch(
        self,
        label: str,
        nodes: list[tuple[str, dict[str, Any]]],
    ) -> int:
        """Batch upsert nodes for a single label.

        Args:
            label: Node label.
            nodes: Sequence of (qualified_name, props).

        Returns:
            Number of rows written.
        """
        ...

    @abstractmethod
    async def merge_edges_batch(
        self,
        rel_type: str,
        edges: list[tuple[str, str, dict[str, Any]]],
    ) -> int:
        """Batch upsert edges for a single relationship type.

        Args:
            rel_type: Relationship type.
            edges: Sequence of (src_qualified_name, dst_qualified_name, props).

        Returns:
            Number of rows written.
        """
        ...

    @abstractmethod
    async def delete_node(self, label: str, qualified_name: str) -> bool:
        """Delete one node by label + qualified name.

        Returns:
            True when a node row was removed, otherwise False.
        """
        ...

    @abstractmethod
    async def delete_edge(
        self,
        rel_type: str,
        src_qualified_name: str,
        dst_qualified_name: str,
    ) -> bool:
        """Delete one edge row.

        Returns:
            True when an edge row was removed, otherwise False.
        """
        ...

    @abstractmethod
    async def delete_edges_for_node(self, rel_type: str, qualified_name: str) -> int:
        """Delete all edges of a relationship type touching a node.

        Returns:
            Number of edge rows deleted.
        """
        ...

    @abstractmethod
    async def query(
        self,
        query_text: str,
        params: dict[str, Any] | None = None,
    ) -> list[dict[str, Any]]:
        """Execute a read-only backend query and return results.

        Args:
            query_text: Backend query string (SQL, PGQ, Cypher, etc.).
            params: Optional parameters to bind into the query.

        Returns:
            A list of result records, each as a dict of column name to value.
        """
        ...

    @abstractmethod
    async def get_labels(self) -> list[str]:
        """Return all node labels present in the graph.

        Returns:
            Sorted list of label strings.
        """
        ...

    @abstractmethod
    async def get_relationship_types(self) -> list[str]:
        """Return all relationship types present in the graph.

        Returns:
            Sorted list of relationship type strings.
        """
        ...

    @abstractmethod
    async def close(self) -> None:
        """Release any resources held by this store (connections, file handles, etc.)."""
        ...
