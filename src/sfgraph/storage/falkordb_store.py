# src/sfgraph/storage/falkordb_store.py
"""FalkorDBStore — GraphStore implementation backed by FalkorDB via Redis protocol.

Uses an asyncio write queue to serialize all mutation operations, preventing
graph corruption under concurrent ingestion (Phase 3 parallel writes).

Package: falkordb==1.6.0 (PyPI)
The 'falkordblite' package (embedded/local path mode) is not available on PyPI.
This implementation uses the Redis-protocol FalkorDB client which connects to
a running FalkorDB or Redis+FalkorDB-module server.

For tests, inject a mock via the graph_override parameter or patch FalkorDB.
"""
import asyncio
import atexit
import logging
from typing import Any

from falkordb import FalkorDB

from sfgraph.storage.base import GraphStore

logger = logging.getLogger(__name__)

_SENTINEL = object()


class FalkorDBStore(GraphStore):
    """GraphStore implementation backed by FalkorDB.

    All write operations are serialized through an asyncio.Queue to prevent
    concurrent mutation of the underlying graph (FalkorDB's Redis client is
    not asyncio-safe for writes).

    Read operations (query, get_labels, get_relationship_types) use ro_query
    directly and bypass the write queue — FalkorDB handles concurrent reads.

    Usage:
        store = FalkorDBStore(host="localhost", port=6379, graph_name="org_graph")
        await store.start()
        await store.merge_node("ApexClass", {"qualifiedName": "Foo"}, {...})
        await store.close()
    """

    def __init__(
        self,
        host: str = "localhost",
        port: int = 6379,
        graph_name: str = "org_graph",
        password: str | None = None,
    ) -> None:
        self._host = host
        self._port = port
        self._graph_name = graph_name
        self._db = FalkorDB(host=host, port=port, password=password)
        self._graph = self._db.select_graph(graph_name)
        self._write_queue: asyncio.Queue = asyncio.Queue()
        self._writer_task: asyncio.Task | None = None
        atexit.register(self._atexit_cleanup)

    async def start(self) -> None:
        """Start the background writer task. Must be awaited before any merge operations."""
        self._writer_task = asyncio.create_task(self._writer_loop())
        logger.debug("FalkorDBStore writer loop started for graph '%s'", self._graph_name)

    async def _writer_loop(self) -> None:
        """Consume write operations from the queue one at a time."""
        while True:
            item = await self._write_queue.get()
            if item is _SENTINEL:
                self._write_queue.task_done()
                break
            cypher, params, future = item
            try:
                result = self._graph.query(cypher, params)
                if not future.done():
                    future.set_result(result)
            except Exception as exc:  # noqa: BLE001
                if not future.done():
                    future.set_exception(exc)
            finally:
                self._write_queue.task_done()

    async def _write(self, cypher: str, params: dict[str, Any] | None = None) -> Any:
        """Enqueue a write operation and await its result.

        This ensures all writes are serialized even when called concurrently.
        """
        loop = asyncio.get_event_loop()
        future: asyncio.Future = loop.create_future()
        await self._write_queue.put((cypher, params or {}, future))
        return await future

    async def merge_node(
        self,
        label: str,
        key_props: dict[str, Any],
        all_props: dict[str, Any],
    ) -> str:
        """Upsert a node using MERGE semantics and return its qualifiedName.

        The MERGE match is on key_props; all_props are applied as SET after match/create.
        """
        key_match = ", ".join(f"{k}: ${k}" for k in key_props)
        set_clause = ", ".join(f"n.{k} = ${k}" for k in all_props)
        cypher = f"MERGE (n:{label} {{{key_match}}}) SET {set_clause} RETURN n.qualifiedName AS qn"
        params = dict(key_props) | dict(all_props)
        result = await self._write(cypher, params)
        if result and result.result_set:
            return result.result_set[0][0] or ""
        return all_props.get("qualifiedName", "")

    async def merge_edge(
        self,
        src_qualified_name: str,
        src_label: str,
        rel_type: str,
        dst_qualified_name: str,
        dst_label: str,
        props: dict[str, Any],
    ) -> None:
        """Upsert a directed relationship between two nodes."""
        set_props = ", ".join(f"r.{k} = $prop_{k}" for k in props)
        prefixed_props = {f"prop_{k}": v for k, v in props.items()}
        cypher = (
            f"MATCH (src:{src_label} {{qualifiedName: $src_qn}}) "
            f"MATCH (dst:{dst_label} {{qualifiedName: $dst_qn}}) "
            f"MERGE (src)-[r:{rel_type}]->(dst)"
        )
        if set_props:
            cypher += f" SET {set_props}"
        params = {"src_qn": src_qualified_name, "dst_qn": dst_qualified_name, **prefixed_props}
        await self._write(cypher, params)

    async def query(
        self,
        cypher: str,
        params: dict[str, Any] | None = None,
    ) -> list[dict[str, Any]]:
        """Execute a read-only Cypher query bypassing the write queue."""
        result = self._graph.ro_query(cypher, params or {})
        rows = []
        if result and result.result_set:
            header = result.header if hasattr(result, "header") and result.header else []
            for record in result.result_set:
                if header and isinstance(record, (list, tuple)):
                    rows.append(dict(zip(header, record)))
                elif isinstance(record, dict):
                    rows.append(record)
                else:
                    # Scalar or wrapped value — return as-is
                    rows.append(record)
        return rows

    async def get_labels(self) -> list[str]:
        """Return all node labels present in the graph."""
        result = self._graph.ro_query("CALL db.labels()")
        labels = []
        if result and result.result_set:
            for row in result.result_set:
                if isinstance(row, (list, tuple)):
                    labels.append(str(row[0]))
                else:
                    labels.append(str(row))
        return sorted(labels)

    async def get_relationship_types(self) -> list[str]:
        """Return all relationship types present in the graph."""
        result = self._graph.ro_query("CALL db.relationshipTypes()")
        rel_types = []
        if result and result.result_set:
            for row in result.result_set:
                if isinstance(row, (list, tuple)):
                    rel_types.append(str(row[0]))
                else:
                    rel_types.append(str(row))
        return sorted(rel_types)

    async def close(self) -> None:
        """Gracefully shut down the writer task and release resources.

        Sends a sentinel to the write queue and awaits the writer task completion
        so that callers can immediately check _writer_task.done() after awaiting.
        """
        await self._write_queue.put(_SENTINEL)
        if self._writer_task is not None:
            await self._writer_task
        try:
            self._db.connection.close()
        except Exception:  # noqa: BLE001
            pass
        logger.debug("FalkorDBStore closed for graph '%s'", self._graph_name)

    def _atexit_cleanup(self) -> None:
        """Best-effort cleanup registered with atexit."""
        try:
            self._db.connection.close()
        except Exception:  # noqa: BLE001
            pass
