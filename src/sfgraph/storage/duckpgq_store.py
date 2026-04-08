"""DuckPGQStore — GraphStore implementation backed by DuckDB (embedded, no server).

Stores nodes in per-label tables and edges in per-relationship-type tables.
Uses DuckDB's property graph extension (PGQ) syntax for MATCH queries.
Runs fully in-process — no Docker, no external server, no network port.

Package: duckdb>=1.0.0

Node tables schema:
    CREATE TABLE "{Label}" (qualified_name VARCHAR PRIMARY KEY, props JSON)

Edge tables schema:
    CREATE TABLE "{REL_TYPE}" (
        src_qualified_name VARCHAR NOT NULL,
        dst_qualified_name VARCHAR NOT NULL,
        props JSON,
        PRIMARY KEY (src_qualified_name, dst_qualified_name)
    )

Schema registry:
    CREATE TABLE _sfgraph_schema (table_name VARCHAR PRIMARY KEY, kind VARCHAR)
    kind is 'node' or 'edge' — loaded on init to restore state across sessions.

Query method accepts DuckDB SQL or PGQ SQL (FROM GRAPH_TABLE syntax).
"""
import asyncio
import json
import logging
import re
from typing import Any

import duckdb

from sfgraph.storage.base import GraphStore

logger = logging.getLogger(__name__)
_IDENTIFIER_RE = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")


class DuckPGQStore(GraphStore):
    """Fully-embedded GraphStore backed by DuckDB.

    No server required. All data lives in a local DuckDB file (or :memory: for tests).
    All methods are async; DuckDB calls are synchronous but run in the single-threaded
    asyncio event loop — acceptable for ingestion workloads (no parallelism needed).

    Usage:
        store = DuckPGQStore(db_path="./data/sfgraph.duckdb")
        await store.merge_node("ApexClass", {"qualifiedName": "Foo"}, {...})
        await store.close()
    """

    def __init__(self, db_path: str = ":memory:") -> None:
        self._db_path = db_path
        self._conn = duckdb.connect(db_path)
        self._node_labels: set[str] = set()
        self._edge_types: set[str] = set()
        self._lock = asyncio.Lock()
        self._init_schema_registry()

    # ------------------------------------------------------------------
    # Initialisation
    # ------------------------------------------------------------------

    def _init_schema_registry(self) -> None:
        """Create the schema registry table and reload any tables from a prior session."""
        self._conn.execute(
            "CREATE TABLE IF NOT EXISTS _sfgraph_schema "
            "(table_name VARCHAR PRIMARY KEY, kind VARCHAR)"
        )
        self._conn.execute(
            "CREATE TABLE IF NOT EXISTS _sfgraph_node_index "
            "(qualified_name VARCHAR PRIMARY KEY, label VARCHAR NOT NULL)"
        )
        self._conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_sfgraph_node_index_label "
            "ON _sfgraph_node_index (label)"
        )
        rows = self._conn.execute(
            "SELECT table_name, kind FROM _sfgraph_schema"
        ).fetchall()
        for table_name, kind in rows:
            if not self._is_valid_identifier(str(table_name)):
                logger.warning("Skipping invalid schema identifier from registry: %r", table_name)
                continue
            if kind == "node":
                self._node_labels.add(table_name)
            elif kind == "edge":
                self._edge_types.add(table_name)
        self._backfill_node_index()
        self._refresh_all_edges_view()

    def _backfill_node_index(self) -> None:
        """Populate node index entries for legacy tables if missing."""
        for label in self._node_labels:
            self._conn.execute(
                f'INSERT OR REPLACE INTO _sfgraph_node_index (qualified_name, label) '
                f'SELECT qualified_name, ? FROM "{label}"',
                [label],
            )

    @staticmethod
    def _is_valid_identifier(name: str) -> bool:
        return bool(_IDENTIFIER_RE.match(name))

    @classmethod
    def _ensure_valid_identifier(cls, name: str, *, kind: str) -> str:
        if not cls._is_valid_identifier(name):
            raise ValueError(
                f"Invalid {kind} identifier {name!r}. "
                "Only [A-Za-z_][A-Za-z0-9_]* are allowed."
            )
        return name

    # ------------------------------------------------------------------
    # Schema helpers (synchronous — called inside async lock)
    # ------------------------------------------------------------------

    def _ensure_node_table(self, label: str) -> None:
        label = self._ensure_valid_identifier(label, kind="label")
        if label in self._node_labels:
            return
        self._conn.execute(
            f'CREATE TABLE IF NOT EXISTS "{label}" '
            f"(qualified_name VARCHAR PRIMARY KEY, props JSON)"
        )
        self._conn.execute(
            "INSERT OR IGNORE INTO _sfgraph_schema (table_name, kind) VALUES (?, ?)",
            [label, "node"],
        )
        self._node_labels.add(label)
        logger.debug("Created node table: %s", label)

    def _ensure_edge_table(self, rel_type: str) -> None:
        rel_type = self._ensure_valid_identifier(rel_type, kind="relationship type")
        if rel_type in self._edge_types:
            return
        self._conn.execute(
            f'CREATE TABLE IF NOT EXISTS "{rel_type}" ('
            f"src_qualified_name VARCHAR NOT NULL, "
            f"dst_qualified_name VARCHAR NOT NULL, "
            f"props JSON, "
            f"PRIMARY KEY (src_qualified_name, dst_qualified_name))"
        )
        self._conn.execute(
            "INSERT OR IGNORE INTO _sfgraph_schema (table_name, kind) VALUES (?, ?)",
            [rel_type, "edge"],
        )
        self._conn.execute(
            f'CREATE INDEX IF NOT EXISTS "idx_{rel_type}_src" '
            f'ON "{rel_type}" (src_qualified_name)'
        )
        self._conn.execute(
            f'CREATE INDEX IF NOT EXISTS "idx_{rel_type}_dst" '
            f'ON "{rel_type}" (dst_qualified_name)'
        )
        self._edge_types.add(rel_type)
        self._refresh_all_edges_view()
        logger.debug("Created edge table: %s", rel_type)

    def _refresh_all_edges_view(self) -> None:
        """(Re)create a unified edge view for fast multi-hop traversal queries."""
        if not self._edge_types:
            self._conn.execute(
                "CREATE OR REPLACE VIEW _sfgraph_all_edges AS "
                "SELECT "
                "CAST(NULL AS VARCHAR) AS src_qualified_name, "
                "CAST(NULL AS VARCHAR) AS dst_qualified_name, "
                "CAST(NULL AS JSON) AS props, "
                "CAST(NULL AS VARCHAR) AS rel_type "
                "WHERE FALSE"
            )
            return

        selects = []
        for rel_type in sorted(self._edge_types):
            selects.append(
                f"SELECT src_qualified_name, dst_qualified_name, props, '{rel_type}' AS rel_type FROM \"{rel_type}\""
            )
        sql = "CREATE OR REPLACE VIEW _sfgraph_all_edges AS " + " UNION ALL ".join(selects)
        self._conn.execute(sql)

    # ------------------------------------------------------------------
    # GraphStore ABC implementation
    # ------------------------------------------------------------------

    async def merge_node(
        self,
        label: str,
        key_props: dict[str, Any],
        all_props: dict[str, Any],
    ) -> str:
        """Upsert a node into the label-specific table. Returns qualifiedName."""
        qualified_name: str = (
            key_props.get("qualifiedName") or all_props.get("qualifiedName", "")
        )
        async with self._lock:
            label = self._ensure_valid_identifier(label, kind="label")
            self._ensure_node_table(label)
            self._conn.execute(
                f'INSERT OR REPLACE INTO "{label}" (qualified_name, props) VALUES (?, ?)',
                [qualified_name, json.dumps(all_props)],
            )
            self._conn.execute(
                "INSERT OR REPLACE INTO _sfgraph_node_index (qualified_name, label) VALUES (?, ?)",
                [qualified_name, label],
            )
        return qualified_name

    async def merge_nodes_batch(
        self,
        label: str,
        nodes: list[tuple[str, dict[str, Any]]],
    ) -> int:
        """Batch upsert nodes for a single label."""
        if not nodes:
            return 0
        async with self._lock:
            label = self._ensure_valid_identifier(label, kind="label")
            self._ensure_node_table(label)
            self._conn.executemany(
                f'INSERT OR REPLACE INTO "{label}" (qualified_name, props) VALUES (?, ?)',
                [(qualified_name, json.dumps(props)) for qualified_name, props in nodes],
            )
            self._conn.executemany(
                "INSERT OR REPLACE INTO _sfgraph_node_index (qualified_name, label) VALUES (?, ?)",
                [(qualified_name, label) for qualified_name, _ in nodes],
            )
        return len(nodes)

    async def merge_edge(
        self,
        src_qualified_name: str,
        src_label: str,
        rel_type: str,
        dst_qualified_name: str,
        dst_label: str,
        props: dict[str, Any],
    ) -> None:
        """Upsert a directed edge into the rel_type-specific table."""
        async with self._lock:
            rel_type = self._ensure_valid_identifier(rel_type, kind="relationship type")
            self._ensure_edge_table(rel_type)
            self._conn.execute(
                f'INSERT OR REPLACE INTO "{rel_type}" '
                f"(src_qualified_name, dst_qualified_name, props) VALUES (?, ?, ?)",
                [src_qualified_name, dst_qualified_name, json.dumps(props)],
            )

    async def merge_edges_batch(
        self,
        rel_type: str,
        edges: list[tuple[str, str, dict[str, Any]]],
    ) -> int:
        """Batch upsert edges for a single relationship type."""
        if not edges:
            return 0
        async with self._lock:
            rel_type = self._ensure_valid_identifier(rel_type, kind="relationship type")
            self._ensure_edge_table(rel_type)
            self._conn.executemany(
                f'INSERT OR REPLACE INTO "{rel_type}" '
                f"(src_qualified_name, dst_qualified_name, props) VALUES (?, ?, ?)",
                [(src_qn, dst_qn, json.dumps(props)) for src_qn, dst_qn, props in edges],
            )
        return len(edges)

    async def query(
        self,
        cypher: str,
        params: dict[str, Any] | None = None,
    ) -> list[dict[str, Any]]:
        """Execute a DuckDB SQL or PGQ SQL statement and return rows as dicts.

        Note: This store uses DuckDB SQL / PGQ syntax, not Cypher.
        The parameter name 'cypher' is inherited from the GraphStore ABC;
        pass DuckDB SQL (including FROM GRAPH_TABLE(...) PGQ queries) here.
        Named params use $name syntax: {'name': 'Foo'} binds $name.
        """
        async with self._lock:
            result = self._conn.execute(cypher, params or {})
            if result.description is None:
                return []
            columns = [desc[0] for desc in result.description]
            return [dict(zip(columns, row)) for row in result.fetchall()]

    async def get_labels(self) -> list[str]:
        """Return all node labels that have been written to this store."""
        return sorted(self._node_labels)

    async def get_relationship_types(self) -> list[str]:
        """Return all relationship types that have been written to this store."""
        return sorted(self._edge_types)

    async def close(self) -> None:
        """Close the DuckDB connection and release file handle."""
        try:
            self._conn.close()
            logger.debug("DuckPGQStore closed: %s", self._db_path)
        except Exception:  # noqa: BLE001
            logger.debug("DuckPGQStore close failed: %s", self._db_path, exc_info=True)
