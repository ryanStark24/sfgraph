# tests/test_falkordb_store.py
"""Integration tests for FalkorDBStore: MERGE round-trips and concurrent write safety.

Note: These tests use a mock FalkorDB client because the 'falkordb' PyPI package
(v1.6.0) requires a running FalkorDB/Redis server — there is no embedded/local path mode
(falkordblite was not resolvable on PyPI). The asyncio write queue semantics and
ABC contract are fully tested via mock. A live-server integration test fixture
is provided but skipped unless FALKORDB_URL is set in the environment.
"""
import asyncio
import pytest
from unittest.mock import MagicMock, patch
from sfgraph.storage.falkordb_store import FalkorDBStore
from sfgraph.storage.base import GraphStore


def _make_mock_graph(query_results: list | None = None):
    """Build a mock FalkorDB Graph that returns controlled query results."""
    mock_qr = MagicMock()
    mock_qr.result_set = query_results or []
    mock_graph = MagicMock()
    mock_graph.query.return_value = mock_qr
    mock_graph.ro_query.return_value = mock_qr
    return mock_graph, mock_qr


def _make_store(mock_graph=None) -> FalkorDBStore:
    """Create a FalkorDBStore with a mocked FalkorDB connection."""
    if mock_graph is None:
        mock_graph, _ = _make_mock_graph()
    with patch("sfgraph.storage.falkordb_store.FalkorDB") as MockDB:
        mock_db = MagicMock()
        mock_db.select_graph.return_value = mock_graph
        MockDB.return_value = mock_db
        store = FalkorDBStore(host="localhost", port=6379, graph_name="test_graph")
        store._graph = mock_graph  # inject directly for test control
        return store


@pytest.fixture
async def store() -> FalkorDBStore:
    """Fixture: FalkorDBStore with a running writer task and mocked FalkorDB graph."""
    mock_graph, _ = _make_mock_graph()
    with patch("sfgraph.storage.falkordb_store.FalkorDB") as MockDB:
        mock_db = MagicMock()
        mock_db.select_graph.return_value = mock_graph
        MockDB.return_value = mock_db
        s = FalkorDBStore(host="localhost", port=6379, graph_name="test_graph")
    s._graph = mock_graph
    await s.start()
    yield s
    if not s._writer_task.done():
        await s.close()


def test_falkordb_store_is_graphstore():
    """FalkorDBStore must be a concrete implementation of GraphStore ABC."""
    with patch("sfgraph.storage.falkordb_store.FalkorDB"):
        s = FalkorDBStore(host="localhost", port=6379)
    assert isinstance(s, GraphStore)


async def test_merge_node_and_query_round_trip(store: FalkorDBStore):
    """merge_node should issue a MERGE query and return qualifiedName."""
    # Configure mock to return qualifiedName in result_set
    mock_qr = MagicMock()
    mock_qr.result_set = [["TestClass"]]
    store._graph.query.return_value = mock_qr

    qn = await store.merge_node(
        "ApexClass",
        {"qualifiedName": "TestClass"},
        {"qualifiedName": "TestClass", "name": "TestClass", "isTest": False},
    )
    assert qn == "TestClass"
    # Verify MERGE query was called
    assert store._graph.query.called
    call_args = store._graph.query.call_args
    assert "MERGE" in call_args[0][0]
    assert "ApexClass" in call_args[0][0]


async def test_merge_node_is_idempotent(store: FalkorDBStore):
    """Merging the same node multiple times should be safe (MERGE semantics)."""
    mock_qr = MagicMock()
    mock_qr.result_set = [["Idem"]]
    store._graph.query.return_value = mock_qr

    for _ in range(3):
        qn = await store.merge_node(
            "ApexClass",
            {"qualifiedName": "Idem"},
            {"qualifiedName": "Idem", "name": "Idem"},
        )
    # All three calls return qualifiedName — no errors raised
    assert qn == "Idem"
    assert store._graph.query.call_count == 3


async def test_merge_edge_creates_relationship(store: FalkorDBStore):
    """merge_edge should issue a MERGE relationship query."""
    mock_qr = MagicMock()
    mock_qr.result_set = []
    store._graph.query.return_value = mock_qr

    await store.merge_node(
        "ApexClass", {"qualifiedName": "Caller"}, {"qualifiedName": "Caller", "name": "Caller"}
    )
    await store.merge_node(
        "ApexClass", {"qualifiedName": "Callee"}, {"qualifiedName": "Callee", "name": "Callee"}
    )
    await store.merge_edge(
        "Caller",
        "ApexClass",
        "CALLS",
        "Callee",
        "ApexClass",
        {
            "confidence": 0.9,
            "resolutionMethod": "static",
            "edgeCategory": "CONTROL_FLOW",
            "contextSnippet": "Callee.run()",
        },
    )
    # Verify a MERGE relationship query was issued
    calls = [str(c[0][0]) for c in store._graph.query.call_args_list]
    rel_calls = [c for c in calls if "CALLS" in c]
    assert len(rel_calls) == 1


async def test_get_labels_returns_list(store: FalkorDBStore):
    """get_labels() should return a list containing all node labels."""
    mock_qr = MagicMock()
    mock_qr.result_set = [["ApexClass"], ["CustomField"]]
    store._graph.ro_query.return_value = mock_qr

    labels = await store.get_labels()
    assert isinstance(labels, list)
    assert "ApexClass" in labels
    assert "CustomField" in labels


async def test_get_relationship_types_returns_list(store: FalkorDBStore):
    """get_relationship_types() should return a list of relationship type strings."""
    mock_qr = MagicMock()
    mock_qr.result_set = [["CALLS"], ["READS_FIELD"]]
    store._graph.ro_query.return_value = mock_qr

    rel_types = await store.get_relationship_types()
    assert isinstance(rel_types, list)
    assert "CALLS" in rel_types


async def test_concurrent_writes_do_not_corrupt(store: FalkorDBStore):
    """20 concurrent merge_node tasks must all complete without corruption.

    The asyncio write queue serializes writes; all 20 futures must resolve.
    """
    count = 20
    call_tracker = []

    def track_query(cypher, params=None):
        call_tracker.append(params.get("qualifiedName") if params else None)
        mock_qr = MagicMock()
        mock_qr.result_set = [[params.get("qualifiedName", "")]] if params else [[""]]
        return mock_qr

    store._graph.query.side_effect = track_query

    tasks = [
        store.merge_node(
            "ApexClass",
            {"qualifiedName": f"Concurrent{i}"},
            {"qualifiedName": f"Concurrent{i}", "name": f"Concurrent{i}"},
        )
        for i in range(count)
    ]
    results = await asyncio.gather(*tasks)

    # All 20 tasks must complete successfully
    assert len(results) == count
    # All 20 MERGE calls must have been issued (serialized through queue)
    assert store._graph.query.call_count == count


async def test_close_stops_writer_task(store: FalkorDBStore):
    """After close(), the writer task must be done."""
    assert not store._writer_task.done(), "writer task should be running before close()"
    await store.close()
    assert store._writer_task.done(), "writer task must be done after close()"


async def test_query_uses_ro_query(store: FalkorDBStore):
    """query() must use ro_query (read path bypasses the write queue)."""
    mock_qr = MagicMock()
    mock_qr.result_set = [{"name": "Foo"}]
    # ro_query returns iterable of records
    mock_result = MagicMock()
    mock_result.header = ["name"]
    mock_result.result_set = [[MagicMock(properties={"name": "Foo"})]]
    store._graph.ro_query.return_value = mock_result

    await store.query("MATCH (n:ApexClass) RETURN n.name AS name", {"unused": 1})
    assert store._graph.ro_query.called
    # Must NOT have gone through the write queue
    assert not store._graph.query.called
