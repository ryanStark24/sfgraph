# tests/test_vector_store.py
"""Integration tests for VectorStore: Qdrant local + fastembed BAAI/bge-small-en-v1.5.

These tests use Qdrant in-memory mode (path=":memory:") for fast, disk-free execution.
The first test run that exercises upsert/search will download BAAI/bge-small-en-v1.5
(~130MB ONNX model) if not already cached by fastembed. Subsequent runs use the cache.
"""
import pytest
from sfgraph.storage.vector_store import VectorStore


@pytest.fixture
async def store() -> VectorStore:
    """Fixture: VectorStore with in-memory Qdrant (no disk I/O)."""
    s = VectorStore(path=":memory:")
    await s.initialize()
    yield s
    # Qdrant in-memory needs no explicit close


async def test_initialize_creates_collection(store: VectorStore):
    """initialize() must create the 'source_chunks' collection."""
    collections = store._client.get_collections().collections
    names = [c.name for c in collections]
    assert "source_chunks" in names


async def test_initialize_is_idempotent():
    """Calling initialize() twice must not raise (handles existing collection)."""
    s = VectorStore(path=":memory:")
    await s.initialize()
    await s.initialize()  # must not raise


async def test_upsert_and_search(store: VectorStore):
    """upsert() + search() round-trip must return the upserted chunk."""
    await store.upsert(
        node_id="ApexClass:AccountService",
        text="public class AccountService { public void processAccount(Account acc) { acc.Status__c = 'Active'; } }",
        payload={"label": "ApexClass", "sourceFile": "force-app/main/default/classes/AccountService.cls"},
    )
    results = await store.search("AccountService process account status", limit=5)
    assert len(results) >= 1
    node_ids = [r["node_id"] for r in results]
    assert "ApexClass:AccountService" in node_ids


async def test_search_result_shape(store: VectorStore):
    """Each search result must have node_id, score (float), and payload keys."""
    await store.upsert(
        node_id="ApexMethod:AccountService.run",
        text="public void run() { return; }",
        payload={"label": "ApexMethod"},
    )
    results = await store.search("AccountService run method", limit=3)
    for r in results:
        assert "node_id" in r
        assert "score" in r
        assert "payload" in r
        assert isinstance(r["score"], float)


async def test_search_returns_node_id(store: VectorStore):
    """search results must include node_id matching what was upserted."""
    await store.upsert(
        node_id="CustomField:Account.Status__c",
        text="CustomField Status__c on Account object",
        payload={"label": "CustomField"},
    )
    results = await store.search("Account status custom field", limit=5)
    node_ids = [r["node_id"] for r in results]
    assert "CustomField:Account.Status__c" in node_ids


def test_vector_store_requires_path_or_url():
    """VectorStore must raise ValueError if neither path nor url is provided."""
    try:
        VectorStore()
        assert False, "Expected ValueError"
    except ValueError as e:
        assert "path" in str(e).lower() or "url" in str(e).lower()


def test_all_storage_exports_importable():
    """Phase 1 ROADMAP success criterion: all four stores importable from sfgraph.storage."""
    from sfgraph.storage import GraphStore, FalkorDBStore, VectorStore, ManifestStore  # noqa: F401
    assert GraphStore is not None
    assert FalkorDBStore is not None
    assert VectorStore is not None
    assert ManifestStore is not None
