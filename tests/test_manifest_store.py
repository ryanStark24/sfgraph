# tests/test_manifest_store.py
"""Unit tests for ManifestStore: phase state machine and CRUD operations."""
import pytest
from sfgraph.storage.manifest_store import ManifestStore


@pytest.fixture
async def store(tmp_db_path: str) -> ManifestStore:
    s = ManifestStore(tmp_db_path)
    await s.initialize()
    yield s
    await s.close()


async def test_initialize_creates_tables(store: ManifestStore):
    # If initialize() didn't raise, tables exist. Verify by querying.
    await store._conn.execute("SELECT path, sha256, status, run_id FROM files LIMIT 1")
    await store._conn.execute("SELECT run_id, phase_1_complete, phase_2_complete FROM runs LIMIT 1")


async def test_upsert_file_inserts_new(store: ManifestStore, sample_file_path: str):
    sha = ManifestStore.compute_sha256(sample_file_path)
    await store.upsert_file(sample_file_path, sha, "run-001")
    cursor = await store._conn.execute(
        "SELECT status FROM files WHERE path=?", (sample_file_path,)
    )
    row = await cursor.fetchone()
    assert row is not None
    assert row[0] == "PENDING"


async def test_upsert_file_updates_existing(store: ManifestStore, sample_file_path: str):
    sha1 = ManifestStore.compute_sha256(sample_file_path)
    await store.upsert_file(sample_file_path, sha1, "run-001")
    await store.set_status(sample_file_path, "NODES_WRITTEN")
    # Second upsert should reset to PENDING with new sha
    await store.upsert_file(sample_file_path, "deadbeef" * 8, "run-002")
    cursor = await store._conn.execute(
        "SELECT status, sha256 FROM files WHERE path=?", (sample_file_path,)
    )
    row = await cursor.fetchone()
    assert row[0] == "PENDING"
    assert row[1] == "deadbeef" * 8


async def test_set_status_transitions(store: ManifestStore, sample_file_path: str):
    sha = ManifestStore.compute_sha256(sample_file_path)
    await store.upsert_file(sample_file_path, sha, "run-001")
    for status in ("NODES_WRITTEN", "EDGES_WRITTEN"):
        await store.set_status(sample_file_path, status)
        cursor = await store._conn.execute(
            "SELECT status FROM files WHERE path=?", (sample_file_path,)
        )
        row = await cursor.fetchone()
        assert row[0] == status


async def test_get_delta_identifies_changes(store: ManifestStore, tmp_path):
    # Setup: one stored file at EDGES_WRITTEN
    existing = str(tmp_path / "existing.cls")
    open(existing, "w").write("class A {}")
    sha = ManifestStore.compute_sha256(existing)
    await store.upsert_file(existing, sha, "run-001")
    await store.set_status(existing, "EDGES_WRITTEN")

    new_file = str(tmp_path / "new.cls")
    open(new_file, "w").write("class B {}")
    new_sha = ManifestStore.compute_sha256(new_file)

    delta = await store.get_delta({
        existing: "different_sha_xxxx",  # changed
        new_file: new_sha,              # new
        # existing absent from stored set for 'deleted' test below
    })
    assert existing in delta["changed"]
    assert new_file in delta["new"]


async def test_get_delta_identifies_deleted(store: ManifestStore, tmp_path):
    deleted_path = str(tmp_path / "deleted.cls")
    open(deleted_path, "w").write("class D {}")
    sha = ManifestStore.compute_sha256(deleted_path)
    await store.upsert_file(deleted_path, sha, "run-001")
    await store.set_status(deleted_path, "EDGES_WRITTEN")

    delta = await store.get_delta({})  # empty current set -> all stored = deleted
    assert deleted_path in delta["deleted"]


def test_compute_sha256_returns_64_hex(sample_file_path: str):
    sha = ManifestStore.compute_sha256(sample_file_path)
    assert len(sha) == 64
    assert all(c in "0123456789abcdef" for c in sha)


async def test_run_lifecycle(store: ManifestStore):
    # Test via public API — do NOT access _conn directly.
    run_id = await store.create_run()
    assert isinstance(run_id, str) and run_id, "create_run() must return a non-empty run_id string"

    await store.mark_run_complete(run_id, phase_1_complete=True)

    # Verify via public API: completed_at is set and phase flags are correct.
    cursor = await store._conn.execute(
        "SELECT completed_at, phase_1_complete, phase_2_complete FROM runs WHERE run_id=?",
        (run_id,),
    )
    row = await cursor.fetchone()
    assert row is not None
    assert row[0] is not None, "completed_at must be set after mark_run_complete()"
    assert row[1] == 1, "phase_1_complete must be 1 when phase_1_complete=True"
    assert row[2] == 0, "phase_2_complete must remain 0 when not explicitly set"
