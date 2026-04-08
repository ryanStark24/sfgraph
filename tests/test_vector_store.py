# tests/test_vector_store.py
"""Integration tests for VectorStore: Qdrant local + fastembed BAAI/bge-small-en-v1.5.

These tests use Qdrant in-memory mode (path=":memory:") for fast, disk-free execution.
The first test run that exercises upsert/search will download BAAI/bge-small-en-v1.5
(~130MB ONNX model) if not already cached by fastembed. Subsequent runs use the cache.
"""
import sys
import types
from types import SimpleNamespace

import pytest
from sfgraph.storage.vector_store import VectorStore


@pytest.fixture(autouse=True)
def fake_fastembed(monkeypatch):
    """Use a deterministic local embedder for unit tests."""

    class _Vector:
        def __init__(self, values):
            self._values = values

        def tolist(self):
            return self._values

    class FakeTextEmbedding:
        def __init__(self, model_name, **kwargs):
            self.model_name = model_name
            self.kwargs = kwargs

        def embed(self, texts):
            for text in texts:
                basis = sum(ord(ch) for ch in str(text)) % 997
                values = [float((basis + idx) % 101) / 100.0 for idx in range(384)]
                yield _Vector(values)

    fake_module = types.SimpleNamespace(TextEmbedding=FakeTextEmbedding)
    monkeypatch.setitem(sys.modules, "fastembed", fake_module)


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


async def test_search_can_filter_project_scope(store: VectorStore):
    await store.upsert(
        node_id="scopeA::ApexClass:AccountService",
        text="Account service class",
        payload={"label": "ApexClass"},
        project_scope="scopeA",
    )
    await store.upsert(
        node_id="scopeB::ApexClass:OtherService",
        text="Other service class",
        payload={"label": "ApexClass"},
        project_scope="scopeB",
    )
    results = await store.search("service class", limit=10, project_scope="scopeA")
    node_ids = {r["node_id"] for r in results}
    assert "scopeA::ApexClass:AccountService" in node_ids
    assert "scopeB::ApexClass:OtherService" not in node_ids


async def test_delete_by_node_ids(store: VectorStore):
    await store.upsert(
        node_id="scopeA::CustomField:Account.Status__c",
        text="status field",
        payload={"label": "CustomField"},
        project_scope="scopeA",
    )
    deleted = await store.delete_by_node_ids(["scopeA::CustomField:Account.Status__c"])
    assert deleted == 1
    results = await store.search("status field", limit=5, project_scope="scopeA")
    assert all(r["node_id"] != "scopeA::CustomField:Account.Status__c" for r in results)


async def test_delete_by_project_scope(store: VectorStore):
    await store.upsert(
        node_id="scopeA::ApexClass:A",
        text="class a",
        payload={"label": "ApexClass"},
        project_scope="scopeA",
    )
    await store.upsert(
        node_id="scopeB::ApexClass:B",
        text="class b",
        payload={"label": "ApexClass"},
        project_scope="scopeB",
    )
    deleted = await store.delete_by_project_scope("scopeA")
    assert deleted >= 1
    results_a = await store.search("class", limit=10, project_scope="scopeA")
    results_b = await store.search("class", limit=10, project_scope="scopeB")
    assert results_a == []
    assert results_b


async def test_delete_by_project_scope_scrolls_all_pages():
    store = VectorStore(path=":memory:")

    deleted_calls: list[list[int]] = []

    class FakeClient:
        def __init__(self):
            self._calls = 0

        def scroll(self, **kwargs):
            self._calls += 1
            if self._calls == 1:
                return ([SimpleNamespace(id=1), SimpleNamespace(id=2)], "offset-2")
            if self._calls == 2:
                return ([SimpleNamespace(id=3)], None)
            raise AssertionError("scroll called too many times")

        def delete(self, *, collection_name, points_selector, wait):
            deleted_calls.append(list(points_selector.points))

    store._client = FakeClient()

    deleted = await store.delete_by_project_scope("scopeA")
    assert deleted == 3
    assert deleted_calls == [[1, 2, 3]]


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


def test_vector_store_uses_offline_embedder_by_default(monkeypatch):
    monkeypatch.delenv("SFGRAPH_ALLOW_NETWORK", raising=False)

    calls: list[dict] = []

    class FakeTextEmbedding:
        def __init__(self, model_name, **kwargs):
            calls.append({"model_name": model_name, **kwargs})

    fake_module = types.SimpleNamespace(TextEmbedding=FakeTextEmbedding)
    monkeypatch.setitem(sys.modules, "fastembed", fake_module)

    store = VectorStore(path=":memory:")
    embedder = store._get_embedder()
    assert embedder is not None
    assert calls[0]["model_name"] == "BAAI/bge-small-en-v1.5"
    assert calls[0]["local_files_only"] is True
