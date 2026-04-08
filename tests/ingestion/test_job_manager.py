from __future__ import annotations

import asyncio
import threading
from pathlib import Path

import pytest

from sfgraph.ingestion.job_manager import IngestJobManager
from sfgraph.ingestion.models import IngestionSummary, RefreshSummary


def _ingest_summary(export_dir: str) -> IngestionSummary:
    return IngestionSummary(
        run_id="run-1",
        export_dir=export_dir,
        duration_seconds=0.1,
        node_counts_by_type={"ApexClass": 1},
        edge_count=2,
        parse_failures=[],
        orphaned_edges=0,
        warnings=[],
        parser_stats={},
        unresolved_symbols=0,
    )


def _refresh_summary(export_dir: str) -> RefreshSummary:
    return RefreshSummary(
        run_id="run-2",
        export_dir=export_dir,
        duration_seconds=0.1,
        processed_files=1,
        changed_files=[f"{export_dir}/a.cls"],
        deleted_files=[],
        affected_neighbor_files=[],
        node_count=3,
        edge_count=4,
        orphaned_edges=0,
        warnings=[],
        parser_stats={},
        unresolved_symbols=0,
    )


@pytest.mark.asyncio
async def test_job_manager_runs_ingest_to_completion(tmp_path: Path):
    async def fake_ingest(export_dir: str, options: dict[str, object], cancel_event: threading.Event):
        await asyncio.sleep(0.01)
        assert options == {}
        assert cancel_event.is_set() is False
        return _ingest_summary(export_dir)

    async def fake_refresh(export_dir: str, options: dict[str, object], cancel_event: threading.Event):
        await asyncio.sleep(0.01)
        assert options == {}
        assert cancel_event.is_set() is False
        return _refresh_summary(export_dir)

    async def fake_vectorize(export_dir: str, options: dict[str, object], cancel_event: threading.Event):
        assert cancel_event.is_set() is False
        return _refresh_summary(export_dir)

    manager = IngestJobManager(
        ingest_factory=fake_ingest,
        refresh_factory=fake_refresh,
        vectorize_factory=fake_vectorize,
    )
    job = await manager.start_job(job_type="ingest", export_dir=str(tmp_path))

    await asyncio.sleep(0.05)

    record = await manager.get_job(job["job_id"])
    assert record is not None
    assert record["state"] == "completed"
    assert record["run_id"] == "run-1"
    assert record["result_summary"]["edge_count"] == 2
    assert manager.active_job_id is None


@pytest.mark.asyncio
async def test_job_manager_blocks_second_active_job(tmp_path: Path):
    gate = asyncio.Event()

    async def fake_ingest(export_dir: str, options: dict[str, object], cancel_event: threading.Event):
        await gate.wait()
        return _ingest_summary(export_dir)

    async def fake_refresh(export_dir: str, options: dict[str, object], cancel_event: threading.Event):
        return _refresh_summary(export_dir)

    async def fake_vectorize(export_dir: str, options: dict[str, object], cancel_event: threading.Event):
        return _refresh_summary(export_dir)

    manager = IngestJobManager(
        ingest_factory=fake_ingest,
        refresh_factory=fake_refresh,
        vectorize_factory=fake_vectorize,
    )
    first = await manager.start_job(job_type="ingest", export_dir=str(tmp_path))
    with pytest.raises(RuntimeError):
        await manager.start_job(job_type="refresh", export_dir=str(tmp_path / "other"))

    gate.set()
    await asyncio.sleep(0.05)

    record = await manager.get_job(first["job_id"])
    assert record is not None
    assert record["state"] == "completed"


@pytest.mark.asyncio
async def test_job_manager_cancels_running_job(tmp_path: Path):
    started = asyncio.Event()
    cancelled_seen = asyncio.Event()

    async def fake_ingest(export_dir: str, options: dict[str, object], cancel_event: threading.Event):
        started.set()
        while not cancel_event.is_set():
            await asyncio.sleep(0.01)
        cancelled_seen.set()
        raise asyncio.CancelledError()

    async def fake_refresh(export_dir: str, options: dict[str, object], cancel_event: threading.Event):
        return _refresh_summary(export_dir)

    async def fake_vectorize(export_dir: str, options: dict[str, object], cancel_event: threading.Event):
        return _refresh_summary(export_dir)

    manager = IngestJobManager(
        ingest_factory=fake_ingest,
        refresh_factory=fake_refresh,
        vectorize_factory=fake_vectorize,
    )
    job = await manager.start_job(job_type="ingest", export_dir=str(tmp_path))

    await started.wait()
    cancelled = await manager.cancel_job(job["job_id"])
    assert cancelled["state"] == "cancelling"
    assert manager.active_job_id == job["job_id"]
    with pytest.raises(RuntimeError):
        await manager.start_job(job_type="refresh", export_dir=str(tmp_path / "other"))

    await cancelled_seen.wait()
    await asyncio.sleep(0.05)
    record = await manager.get_job(job["job_id"])
    assert record is not None
    assert record["state"] == "cancelled"
    assert record["error"] == "cancelled"
    assert manager.active_job_id is None


@pytest.mark.asyncio
async def test_job_manager_preserves_job_options(tmp_path: Path):
    seen_options: dict[str, object] = {}

    async def fake_ingest(export_dir: str, options: dict[str, object], cancel_event: threading.Event):
        seen_options.update(options)
        assert cancel_event.is_set() is False
        return _ingest_summary(export_dir)

    async def fake_refresh(export_dir: str, options: dict[str, object], cancel_event: threading.Event):
        return _refresh_summary(export_dir)

    async def fake_vectorize(export_dir: str, options: dict[str, object], cancel_event: threading.Event):
        return _refresh_summary(export_dir)

    manager = IngestJobManager(
        ingest_factory=fake_ingest,
        refresh_factory=fake_refresh,
        vectorize_factory=fake_vectorize,
    )
    job = await manager.start_job(
        job_type="ingest",
        export_dir=str(tmp_path),
        options={"mode": "graph_only"},
    )

    await asyncio.sleep(0.05)
    record = await manager.get_job(job["job_id"])
    assert record is not None
    assert record["options"] == {"mode": "graph_only"}
    assert seen_options == {"mode": "graph_only"}


@pytest.mark.asyncio
async def test_job_manager_runs_vectorize_job(tmp_path: Path):
    async def fake_ingest(export_dir: str, options: dict[str, object], cancel_event: threading.Event):
        return _ingest_summary(export_dir)

    async def fake_refresh(export_dir: str, options: dict[str, object], cancel_event: threading.Event):
        return _refresh_summary(export_dir)

    async def fake_vectorize(export_dir: str, options: dict[str, object], cancel_event: threading.Event):
        return _refresh_summary(export_dir)

    manager = IngestJobManager(
        ingest_factory=fake_ingest,
        refresh_factory=fake_refresh,
        vectorize_factory=fake_vectorize,
    )
    job = await manager.start_job(job_type="vectorize", export_dir=str(tmp_path))
    await asyncio.sleep(0.05)
    record = await manager.get_job(job["job_id"])
    assert record is not None
    assert record["state"] == "completed"


@pytest.mark.asyncio
async def test_job_manager_marks_cancelled_when_cancel_requested_but_runner_returns_summary(tmp_path: Path):
    started = asyncio.Event()
    proceed = asyncio.Event()

    async def fake_ingest(export_dir: str, options: dict[str, object], cancel_event: threading.Event):
        started.set()
        await proceed.wait()
        # Simulate a runner that exits cleanly despite cancellation request.
        return _ingest_summary(export_dir)

    async def fake_refresh(export_dir: str, options: dict[str, object], cancel_event: threading.Event):
        return _refresh_summary(export_dir)

    async def fake_vectorize(export_dir: str, options: dict[str, object], cancel_event: threading.Event):
        return _refresh_summary(export_dir)

    manager = IngestJobManager(
        ingest_factory=fake_ingest,
        refresh_factory=fake_refresh,
        vectorize_factory=fake_vectorize,
    )
    job = await manager.start_job(job_type="ingest", export_dir=str(tmp_path))
    await started.wait()
    cancelled = await manager.cancel_job(job["job_id"])
    assert cancelled["state"] == "cancelling"

    proceed.set()
    await asyncio.sleep(0.05)
    record = await manager.get_job(job["job_id"])
    assert record is not None
    assert record["state"] == "cancelled"
    assert manager.active_job_id is None


@pytest.mark.asyncio
async def test_job_manager_persists_jobs_across_restarts(tmp_path: Path):
    db_path = tmp_path / "jobs.sqlite"

    async def fake_ingest(export_dir: str, options: dict[str, object], cancel_event: threading.Event):
        return _ingest_summary(export_dir)

    async def fake_refresh(export_dir: str, options: dict[str, object], cancel_event: threading.Event):
        return _refresh_summary(export_dir)

    async def fake_vectorize(export_dir: str, options: dict[str, object], cancel_event: threading.Event):
        return _refresh_summary(export_dir)

    manager = IngestJobManager(
        ingest_factory=fake_ingest,
        refresh_factory=fake_refresh,
        vectorize_factory=fake_vectorize,
        db_path=str(db_path),
    )
    await manager.initialize()
    job = await manager.start_job(job_type="ingest", export_dir=str(tmp_path))
    await asyncio.sleep(0.05)
    await manager.close()

    manager2 = IngestJobManager(
        ingest_factory=fake_ingest,
        refresh_factory=fake_refresh,
        vectorize_factory=fake_vectorize,
        db_path=str(db_path),
    )
    await manager2.initialize()
    restored = await manager2.get_job(job["job_id"])
    assert restored is not None
    assert restored["state"] == "completed"
    assert restored["run_id"] == "run-1"
    await manager2.close()


@pytest.mark.asyncio
async def test_job_manager_marks_stale_running_job_as_daemon_restarted(tmp_path: Path):
    db_path = tmp_path / "jobs.sqlite"

    async def fake_ingest(export_dir: str, options: dict[str, object], cancel_event: threading.Event):
        return _ingest_summary(export_dir)

    async def fake_refresh(export_dir: str, options: dict[str, object], cancel_event: threading.Event):
        return _refresh_summary(export_dir)

    async def fake_vectorize(export_dir: str, options: dict[str, object], cancel_event: threading.Event):
        return _refresh_summary(export_dir)

    manager = IngestJobManager(
        ingest_factory=fake_ingest,
        refresh_factory=fake_refresh,
        vectorize_factory=fake_vectorize,
        db_path=str(db_path),
    )
    await manager.initialize()
    await manager._db.execute(  # noqa: SLF001
        """
        INSERT INTO ingest_jobs (
            job_id, job_type, export_dir, state, created_at, started_at, completed_at,
            error, run_id, options_json, result_summary_json, updated_at, recovery_reason
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            "job-stale-running",
            "ingest",
            str(tmp_path),
            "running",
            "2026-04-07T00:00:00+00:00",
            "2026-04-07T00:00:05+00:00",
            None,
            None,
            None,
            "{}",
            None,
            "2026-04-07T00:00:05+00:00",
            None,
        ),
    )
    await manager._db.execute(  # noqa: SLF001
        "UPDATE ingest_job_state SET value = 'job-stale-running' WHERE key = 'active_job_id'"
    )
    await manager._db.commit()  # noqa: SLF001
    await manager.close()

    manager2 = IngestJobManager(
        ingest_factory=fake_ingest,
        refresh_factory=fake_refresh,
        vectorize_factory=fake_vectorize,
        db_path=str(db_path),
    )
    await manager2.initialize()
    restored = await manager2.get_job("job-stale-running")
    assert restored is not None
    assert restored["state"] == "failed"
    assert restored["error"] == "daemon_restarted"
    assert restored["recovery_reason"] == "daemon_restarted"
    assert manager2.active_job_id is None
    await manager2.close()
