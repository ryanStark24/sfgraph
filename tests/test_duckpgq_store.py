# tests/test_duckpgq_store.py
"""Unit tests for DuckPGQStore — fully embedded, no Docker, no server required.

All tests use in-memory DuckDB (':memory:') for isolation and speed.
"""
import pytest
from sfgraph.storage.duckpgq_store import DuckPGQStore
from sfgraph.storage.base import GraphStore


@pytest.fixture
async def store() -> DuckPGQStore:
    s = DuckPGQStore()  # :memory: by default
    yield s
    await s.close()


def test_duckpgq_is_graphstore():
    store = DuckPGQStore()
    assert isinstance(store, GraphStore)


# ------------------------------------------------------------------
# merge_node
# ------------------------------------------------------------------

async def test_merge_node_returns_qualified_name(store):
    qn = await store.merge_node(
        "ApexClass",
        {"qualifiedName": "AccountService"},
        {"qualifiedName": "AccountService", "name": "AccountService", "isTest": False},
    )
    assert qn == "AccountService"


async def test_merge_node_is_idempotent(store):
    """Merging the same node three times must not raise and must return the same qn."""
    props = {"qualifiedName": "Idem", "name": "Idem"}
    for _ in range(3):
        qn = await store.merge_node("ApexClass", {"qualifiedName": "Idem"}, props)
    assert qn == "Idem"


async def test_merge_node_updates_props_on_conflict(store):
    """A second merge with different props should overwrite (INSERT OR REPLACE)."""
    await store.merge_node(
        "ApexClass",
        {"qualifiedName": "Cls"},
        {"qualifiedName": "Cls", "name": "OldName"},
    )
    await store.merge_node(
        "ApexClass",
        {"qualifiedName": "Cls"},
        {"qualifiedName": "Cls", "name": "NewName"},
    )
    rows = await store.query('SELECT props FROM "ApexClass" WHERE qualified_name = $qn', {"qn": "Cls"})
    assert len(rows) == 1
    import json
    stored = json.loads(rows[0]["props"])
    assert stored["name"] == "NewName"


async def test_merge_node_different_labels_separate_tables(store):
    """Different labels must be stored in separate tables."""
    await store.merge_node("ApexClass", {"qualifiedName": "A"}, {"qualifiedName": "A"})
    await store.merge_node("SFObject", {"qualifiedName": "Account"}, {"qualifiedName": "Account"})
    labels = await store.get_labels()
    assert "ApexClass" in labels
    assert "SFObject" in labels


# ------------------------------------------------------------------
# merge_edge
# ------------------------------------------------------------------

async def test_merge_edge_stores_relationship(store):
    await store.merge_node("ApexClass", {"qualifiedName": "Caller"}, {"qualifiedName": "Caller"})
    await store.merge_node("ApexClass", {"qualifiedName": "Callee"}, {"qualifiedName": "Callee"})
    await store.merge_edge(
        "Caller", "ApexClass", "CALLS", "Callee", "ApexClass",
        {"confidence": 0.9, "edgeCategory": "CONTROL_FLOW"},
    )
    rows = await store.query('SELECT src_qualified_name, dst_qualified_name FROM "CALLS"')
    assert len(rows) == 1
    assert rows[0]["src_qualified_name"] == "Caller"
    assert rows[0]["dst_qualified_name"] == "Callee"


async def test_merge_edge_is_idempotent(store):
    await store.merge_node("ApexClass", {"qualifiedName": "A"}, {"qualifiedName": "A"})
    await store.merge_node("ApexClass", {"qualifiedName": "B"}, {"qualifiedName": "B"})
    for _ in range(3):
        await store.merge_edge("A", "ApexClass", "CALLS", "B", "ApexClass", {"confidence": 0.9})
    rows = await store.query('SELECT COUNT(*) AS cnt FROM "CALLS"')
    assert rows[0]["cnt"] == 1


async def test_merge_edge_updates_props_on_conflict(store):
    await store.merge_node("SFObject", {"qualifiedName": "Account"}, {"qualifiedName": "Account"})
    await store.merge_node("SFField", {"qualifiedName": "Account.Name"}, {"qualifiedName": "Account.Name"})
    await store.merge_edge(
        "Account", "SFObject", "HAS_FIELD", "Account.Name", "SFField",
        {"confidence": 0.8},
    )
    await store.merge_edge(
        "Account", "SFObject", "HAS_FIELD", "Account.Name", "SFField",
        {"confidence": 1.0},
    )
    rows = await store.query('SELECT props FROM "HAS_FIELD"')
    import json
    assert json.loads(rows[0]["props"])["confidence"] == 1.0


# ------------------------------------------------------------------
# get_labels / get_relationship_types
# ------------------------------------------------------------------

async def test_get_labels_empty_on_new_store(store):
    labels = await store.get_labels()
    assert labels == []


async def test_get_labels_returns_sorted_list(store):
    await store.merge_node("SFObject", {"qualifiedName": "o"}, {"qualifiedName": "o"})
    await store.merge_node("ApexClass", {"qualifiedName": "a"}, {"qualifiedName": "a"})
    labels = await store.get_labels()
    assert labels == sorted(labels)
    assert "ApexClass" in labels
    assert "SFObject" in labels


async def test_get_relationship_types_empty_on_new_store(store):
    assert await store.get_relationship_types() == []


async def test_get_relationship_types_returns_sorted_list(store):
    await store.merge_node("ApexClass", {"qualifiedName": "X"}, {"qualifiedName": "X"})
    await store.merge_node("ApexClass", {"qualifiedName": "Y"}, {"qualifiedName": "Y"})
    await store.merge_edge("X", "ApexClass", "READS_FIELD", "Y", "ApexClass", {})
    await store.merge_edge("X", "ApexClass", "CALLS", "Y", "ApexClass", {})
    rel_types = await store.get_relationship_types()
    assert rel_types == sorted(rel_types)
    assert "CALLS" in rel_types
    assert "READS_FIELD" in rel_types


# ------------------------------------------------------------------
# query
# ------------------------------------------------------------------

async def test_query_returns_list_of_dicts(store):
    await store.merge_node("ApexClass", {"qualifiedName": "Q"}, {"qualifiedName": "Q", "name": "Q"})
    rows = await store.query('SELECT qualified_name FROM "ApexClass"')
    assert isinstance(rows, list)
    assert len(rows) == 1
    assert isinstance(rows[0], dict)
    assert rows[0]["qualified_name"] == "Q"


async def test_query_with_named_params(store):
    await store.merge_node("ApexClass", {"qualifiedName": "P1"}, {"qualifiedName": "P1"})
    await store.merge_node("ApexClass", {"qualifiedName": "P2"}, {"qualifiedName": "P2"})
    rows = await store.query(
        'SELECT qualified_name FROM "ApexClass" WHERE qualified_name = $qn',
        {"qn": "P1"},
    )
    assert len(rows) == 1
    assert rows[0]["qualified_name"] == "P1"


async def test_query_empty_result(store):
    await store.merge_node("ApexClass", {"qualifiedName": "Z"}, {"qualifiedName": "Z"})
    rows = await store.query(
        'SELECT qualified_name FROM "ApexClass" WHERE qualified_name = $qn',
        {"qn": "NONEXISTENT"},
    )
    assert rows == []


# ------------------------------------------------------------------
# Schema persistence (file-based reconnection)
# ------------------------------------------------------------------

async def test_schema_registry_persists_across_reconnect(tmp_path):
    """Labels and edge types survive close() + reconnect to same file."""
    db_file = str(tmp_path / "test.duckdb")
    store1 = DuckPGQStore(db_path=db_file)
    await store1.merge_node("ApexClass", {"qualifiedName": "Foo"}, {"qualifiedName": "Foo"})
    await store1.merge_node("SFObject", {"qualifiedName": "Bar"}, {"qualifiedName": "Bar"})
    await store1.merge_edge("Foo", "ApexClass", "CALLS", "Bar", "SFObject", {})
    await store1.close()

    store2 = DuckPGQStore(db_path=db_file)
    labels = await store2.get_labels()
    rel_types = await store2.get_relationship_types()
    assert "ApexClass" in labels
    assert "SFObject" in labels
    assert "CALLS" in rel_types
    idx = await store2.query(
        "SELECT label FROM _sfgraph_node_index WHERE qualified_name = $qn",
        {"qn": "Foo"},
    )
    assert idx
    assert idx[0]["label"] == "ApexClass"
    await store2.close()


# ------------------------------------------------------------------
# close
# ------------------------------------------------------------------

async def test_close_is_idempotent():
    store = DuckPGQStore()
    await store.close()
    await store.close()  # second close must not raise


async def test_merge_node_rejects_invalid_label(store):
    with pytest.raises(ValueError, match="Invalid label identifier"):
        await store.merge_node(
            'Bad"Label',
            {"qualifiedName": "Q"},
            {"qualifiedName": "Q"},
        )


async def test_merge_edge_rejects_invalid_relationship_type(store):
    await store.merge_node("ApexClass", {"qualifiedName": "A"}, {"qualifiedName": "A"})
    await store.merge_node("ApexClass", {"qualifiedName": "B"}, {"qualifiedName": "B"})
    with pytest.raises(ValueError, match="Invalid relationship type identifier"):
        await store.merge_edge("A", "ApexClass", 'BAD"REL', "B", "ApexClass", {})


async def test_merge_nodes_batch_upserts_nodes_and_index(store):
    inserted = await store.merge_nodes_batch(
        "ApexClass",
        [
            ("BatchA", {"qualifiedName": "BatchA"}),
            ("BatchB", {"qualifiedName": "BatchB"}),
        ],
    )
    assert inserted == 2
    rows = await store.query('SELECT qualified_name FROM "ApexClass" ORDER BY qualified_name')
    assert [r["qualified_name"] for r in rows] == ["BatchA", "BatchB"]
    idx = await store.query(
        "SELECT qualified_name, label FROM _sfgraph_node_index WHERE qualified_name IN ($a, $b) ORDER BY qualified_name",
        {"a": "BatchA", "b": "BatchB"},
    )
    assert len(idx) == 2
    assert all(row["label"] == "ApexClass" for row in idx)


async def test_merge_edges_batch_upserts_edges(store):
    await store.merge_node("ApexClass", {"qualifiedName": "Src"}, {"qualifiedName": "Src"})
    await store.merge_node("ApexClass", {"qualifiedName": "Dst"}, {"qualifiedName": "Dst"})
    inserted = await store.merge_edges_batch(
        "CALLS",
        [
            ("Src", "Dst", {"confidence": 0.8}),
            ("Src", "Dst2", {"confidence": 0.6}),
        ],
    )
    assert inserted == 2
    rows = await store.query('SELECT src_qualified_name, dst_qualified_name FROM "CALLS" ORDER BY dst_qualified_name')
    assert [r["dst_qualified_name"] for r in rows] == ["Dst", "Dst2"]
