from __future__ import annotations

import asyncio
import threading
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest

from sfgraph.daemon_service import DaemonOperations, _run_job_in_worker_process


class _FakeJobs:
    def __init__(self, *, active_job_id: str | None = None, job_payload: dict | None = None) -> None:
        self.active_job_id = active_job_id
        self._job_payload = dict(job_payload or {})

    async def get_active_job(self):
        if not self.active_job_id:
            return None
        return dict(self._job_payload)

    async def get_job(self, job_id: str):
        if self._job_payload and self._job_payload.get("job_id") == job_id:
            return dict(self._job_payload)
        return None

    async def resume_job(self, job_id: str):
        if not self._job_payload or self._job_payload.get("job_id") != job_id:
            raise KeyError(job_id)
        resumed = {
            "job_id": "job-resumed",
            "job_type": self._job_payload.get("job_type", "ingest"),
            "export_dir": self._job_payload.get("export_dir", "/tmp/repo"),
            "state": "queued",
            "options": {"resume_checkpoint": True, "resumed_from_job_id": job_id},
            "recovery_reason": "checkpoint_resume",
        }
        self.active_job_id = "job-resumed"
        self._job_payload = dict(resumed)
        return resumed


@pytest.mark.asyncio
async def test_get_ingestion_status_merges_active_job_and_vector_health(monkeypatch: pytest.MonkeyPatch):
    fake_query_service = SimpleNamespace(
        get_ingestion_status=AsyncMock(return_value={"status_counts": {"tracked": 1}}),
    )
    monkeypatch.setattr("sfgraph.daemon_service.build_query_service", lambda app: fake_query_service)
    monkeypatch.setattr(
        "sfgraph.daemon_service.read_progress_snapshot",
        lambda data_root: {"available": True, "state": "running", "phase": "writing_nodes", "vector_health": {"enabled": True, "status": "degraded"}},
    )

    app = SimpleNamespace(
        jobs=_FakeJobs(
            active_job_id="job-1",
            job_payload={"job_id": "job-1", "job_type": "ingest", "state": "running", "export_dir": "/tmp/repo"},
        ),
        vectors=SimpleNamespace(health_snapshot=lambda: {"enabled": True, "status": "ready"}),
        data_root=Path("/tmp"),
    )
    ops = DaemonOperations(app)
    payload = await ops.get_ingestion_status({})

    assert payload["active_job"]["job_id"] == "job-1"
    assert payload["active_job"]["progress"]["phase"] == "writing_nodes"
    assert payload["vector_health"]["status"] == "degraded"


@pytest.mark.asyncio
async def test_get_ingestion_progress_exposes_vector_health(monkeypatch: pytest.MonkeyPatch):
    fake_query_service = SimpleNamespace(
        get_ingestion_progress=AsyncMock(return_value={"available": True, "state": "running", "vector_health": {"enabled": False, "status": "disabled"}}),
    )
    monkeypatch.setattr("sfgraph.daemon_service.build_query_service", lambda app: fake_query_service)

    app = SimpleNamespace(
        jobs=_FakeJobs(
            active_job_id="job-2",
            job_payload={"job_id": "job-2", "job_type": "refresh", "state": "running", "export_dir": "/tmp/repo"},
        ),
        vectors=SimpleNamespace(health_snapshot=lambda: {"enabled": True, "status": "ready"}),
        data_root=Path("/tmp"),
    )
    ops = DaemonOperations(app)
    payload = await ops.get_ingestion_progress({})

    assert payload["active_job"]["job_id"] == "job-2"
    assert payload["vector_health"]["status"] == "disabled"


@pytest.mark.asyncio
async def test_get_ingest_job_merges_progress_and_vector_health(monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setattr(
        "sfgraph.daemon_service.read_progress_snapshot",
        lambda data_root: {"available": True, "state": "running", "phase": "parsing", "vector_health": {"enabled": True, "status": "ok"}},
    )
    app = SimpleNamespace(
        jobs=_FakeJobs(
            active_job_id="job-3",
            job_payload={"job_id": "job-3", "job_type": "ingest", "state": "running", "export_dir": "/tmp/repo"},
        ),
        vectors=SimpleNamespace(health_snapshot=lambda: {"enabled": True, "status": "ready"}),
        data_root=Path("/tmp"),
    )
    ops = DaemonOperations(app)
    payload = await ops.get_ingest_job({"job_id": "job-3"})

    assert payload["available"] is True
    assert payload["progress"]["phase"] == "parsing"
    assert payload["vector_health"]["status"] == "ok"


@pytest.mark.asyncio
async def test_resume_ingest_job_dispatch():
    app = SimpleNamespace(
        jobs=_FakeJobs(
            active_job_id=None,
            job_payload={"job_id": "job-old", "job_type": "ingest", "state": "failed", "export_dir": "/tmp/repo"},
        ),
        vectors=SimpleNamespace(health_snapshot=lambda: {"enabled": True, "status": "ready"}),
        data_root=Path("/tmp"),
    )
    ops = DaemonOperations(app)
    payload = await ops.resume_ingest_job({"job_id": "job-old"})

    assert payload["job_id"] == "job-resumed"
    assert payload["options"]["resume_checkpoint"] is True


@pytest.mark.asyncio
async def test_worker_process_runner_hard_cancels_when_event_is_set(tmp_path: Path):
    cancel_event = threading.Event()
    cancel_event.set()

    with pytest.raises(asyncio.CancelledError):
        await _run_job_in_worker_process(
            job_type="ingest",
            data_root=tmp_path / "data",
            export_dir=str(tmp_path / "repo"),
            options={"mode": "graph_only"},
            cancel_event=cancel_event,
        )
