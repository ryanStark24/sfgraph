from __future__ import annotations

import asyncio
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
    async def fake_ingest(export_dir: str, options: dict[str, object]):
        await asyncio.sleep(0.01)
        assert options == {}
        return _ingest_summary(export_dir)

    async def fake_refresh(export_dir: str, options: dict[str, object]):
        await asyncio.sleep(0.01)
        assert options == {}
        return _refresh_summary(export_dir)

    manager = IngestJobManager(ingest_factory=fake_ingest, refresh_factory=fake_refresh)
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

    async def fake_ingest(export_dir: str, options: dict[str, object]):
        await gate.wait()
        return _ingest_summary(export_dir)

    async def fake_refresh(export_dir: str, options: dict[str, object]):
        return _refresh_summary(export_dir)

    manager = IngestJobManager(ingest_factory=fake_ingest, refresh_factory=fake_refresh)
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
    gate = asyncio.Event()

    async def fake_ingest(export_dir: str, options: dict[str, object]):
        await gate.wait()
        return _ingest_summary(export_dir)

    async def fake_refresh(export_dir: str, options: dict[str, object]):
        return _refresh_summary(export_dir)

    manager = IngestJobManager(ingest_factory=fake_ingest, refresh_factory=fake_refresh)
    job = await manager.start_job(job_type="ingest", export_dir=str(tmp_path))

    await asyncio.sleep(0.01)
    cancelled = await manager.cancel_job(job["job_id"])
    assert cancelled["state"] == "cancelling"

    await asyncio.sleep(0.05)
    record = await manager.get_job(job["job_id"])
    assert record is not None
    assert record["state"] == "cancelled"
    assert record["error"] == "cancelled"
    assert manager.active_job_id is None


@pytest.mark.asyncio
async def test_job_manager_preserves_job_options(tmp_path: Path):
    seen_options: dict[str, object] = {}

    async def fake_ingest(export_dir: str, options: dict[str, object]):
        seen_options.update(options)
        return _ingest_summary(export_dir)

    async def fake_refresh(export_dir: str, options: dict[str, object]):
        return _refresh_summary(export_dir)

    manager = IngestJobManager(ingest_factory=fake_ingest, refresh_factory=fake_refresh)
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
