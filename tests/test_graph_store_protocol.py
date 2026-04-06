"""Protocol contract tests for GraphStore ABC and DuckPGQStore stub.

Uses a minimal MockGraphStore to verify the ABC contract is complete
and enforceable without importing any storage backend.
"""
import inspect
import pytest
from sfgraph.storage.base import GraphStore
from sfgraph.storage.duckpgq_store import DuckPGQStore
from sfgraph.storage import GraphStore as GraphStoreExport
from sfgraph.storage import DuckPGQStore as DuckPGQStoreExport


# Minimal complete implementation for testing the contract
class MockGraphStore(GraphStore):
    async def merge_node(self, label, key_props, all_props): return "mock_qn"
    async def merge_edge(self, src_qn, src_label, rel_type, dst_qn, dst_label, props): pass
    async def query(self, cypher, params=None): return []
    async def get_labels(self): return []
    async def get_relationship_types(self): return []
    async def close(self): pass


def test_graphstore_is_abstract():
    with pytest.raises(TypeError):
        GraphStore()  # type: ignore[abstract]


def test_incomplete_implementation_raises():
    class BrokenStore(GraphStore):
        async def merge_node(self, label, key_props, all_props): return ""
        async def merge_edge(self, src_qn, src_label, rel_type, dst_qn, dst_label, props): pass
        # missing: query, get_labels, get_relationship_types, close
    with pytest.raises(TypeError):
        BrokenStore()


def test_complete_mock_implementation_instantiates():
    store = MockGraphStore()
    assert isinstance(store, GraphStore)


async def test_mock_merge_node_returns_string():
    store = MockGraphStore()
    result = await store.merge_node("ApexClass", {"qualifiedName": "Foo"}, {"qualifiedName": "Foo"})
    assert isinstance(result, str)


async def test_mock_query_returns_list():
    store = MockGraphStore()
    result = await store.query("MATCH (n) RETURN n")
    assert isinstance(result, list)


def test_duckpgq_importable_from_storage():
    assert DuckPGQStoreExport is DuckPGQStore


def test_graphstore_importable_from_storage():
    assert GraphStoreExport is GraphStore


async def test_duckpgq_close_does_not_raise():
    store = DuckPGQStore()
    await store.close()  # must not raise


async def test_duckpgq_is_graphstore():
    store = DuckPGQStore()
    assert isinstance(store, GraphStore)
    await store.close()


async def test_duckpgq_merge_node_returns_qualified_name():
    store = DuckPGQStore()
    qn = await store.merge_node(
        "ApexClass",
        {"qualifiedName": "Foo"},
        {"qualifiedName": "Foo", "name": "Foo"},
    )
    assert qn == "Foo"
    await store.close()


async def test_duckpgq_get_labels_after_merge():
    store = DuckPGQStore()
    await store.merge_node("ApexClass", {"qualifiedName": "X"}, {"qualifiedName": "X"})
    labels = await store.get_labels()
    assert "ApexClass" in labels
    await store.close()


async def test_duckpgq_get_relationship_types_after_merge():
    store = DuckPGQStore()
    await store.merge_node("ApexClass", {"qualifiedName": "A"}, {"qualifiedName": "A"})
    await store.merge_node("ApexClass", {"qualifiedName": "B"}, {"qualifiedName": "B"})
    await store.merge_edge("A", "ApexClass", "CALLS", "B", "ApexClass", {})
    rel_types = await store.get_relationship_types()
    assert "CALLS" in rel_types
    await store.close()


def test_no_falkordb_import_in_base():
    import sfgraph.storage.base as base_module
    source = inspect.getsource(base_module)
    assert "falkordb" not in source.lower()
    assert "redislite" not in source.lower()
