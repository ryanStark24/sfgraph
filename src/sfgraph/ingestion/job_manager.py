"""Background ingest job management for MCP-friendly polling."""
from __future__ import annotations

import asyncio
import threading
import uuid
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any, Awaitable, Callable

from sfgraph.ingestion.models import IngestionSummary, RefreshSummary, VectorizeSummary

IngestResult = IngestionSummary | RefreshSummary | VectorizeSummary
IngestCallable = Callable[[str, dict[str, Any], threading.Event], Awaitable[IngestResult]]


def _utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


@dataclass
class IngestJobRecord:
    """Tracks one background ingest or refresh job."""

    job_id: str
    job_type: str
    export_dir: str
    state: str = "queued"
    created_at: str = field(default_factory=_utc_now)
    started_at: str | None = None
    completed_at: str | None = None
    error: str | None = None
    run_id: str | None = None
    options: dict[str, Any] = field(default_factory=dict)
    result_summary: dict[str, Any] | None = None
    _task: asyncio.Task[None] | None = field(default=None, repr=False, compare=False)
    _cancel_event: threading.Event = field(default_factory=threading.Event, repr=False, compare=False)

    def to_dict(self) -> dict[str, Any]:
        return {
            "job_id": self.job_id,
            "job_type": self.job_type,
            "export_dir": self.export_dir,
            "state": self.state,
            "created_at": self.created_at,
            "started_at": self.started_at,
            "completed_at": self.completed_at,
            "error": self.error,
            "run_id": self.run_id,
            "options": self.options,
            "result_summary": self.result_summary,
        }


class IngestJobManager:
    """Owns one active background ingest/refresh job per workspace process."""

    def __init__(
        self,
        ingest_factory: Callable[[str, dict[str, Any]], Awaitable[IngestResult]],
        refresh_factory: Callable[[str, dict[str, Any]], Awaitable[IngestResult]],
        vectorize_factory: Callable[[str, dict[str, Any]], Awaitable[IngestResult]],
    ) -> None:
        self._ingest_factory = ingest_factory
        self._refresh_factory = refresh_factory
        self._vectorize_factory = vectorize_factory
        self._jobs: dict[str, IngestJobRecord] = {}
        self._active_job_id: str | None = None
        self._lock = asyncio.Lock()

    @property
    def active_job_id(self) -> str | None:
        return self._active_job_id

    async def start_job(
        self,
        *,
        job_type: str,
        export_dir: str,
        options: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        """Start an ingest or refresh in the background."""
        if job_type not in {"ingest", "refresh", "vectorize"}:
            raise ValueError(f"Unsupported job_type: {job_type}")

        async with self._lock:
            active = self._get_active_job_locked()
            if active is not None:
                raise RuntimeError(
                    f"Job {active.job_id} is already {active.state} for {active.export_dir}. "
                    "Only one active ingest job is supported per workspace right now."
                )

            job = IngestJobRecord(
                job_id=str(uuid.uuid4()),
                job_type=job_type,
                export_dir=export_dir,
                options=dict(options or {}),
            )
            self._jobs[job.job_id] = job
            self._active_job_id = job.job_id
            job._task = asyncio.create_task(self._run_job(job), name=f"sfgraph-{job_type}-{job.job_id}")
            return job.to_dict()

    async def list_jobs(self) -> list[dict[str, Any]]:
        async with self._lock:
            jobs = sorted(
                (job.to_dict() for job in self._jobs.values()),
                key=lambda payload: payload["created_at"],
                reverse=True,
            )
        return jobs

    async def get_job(self, job_id: str) -> dict[str, Any] | None:
        async with self._lock:
            job = self._jobs.get(job_id)
            return None if job is None else job.to_dict()

    async def get_active_job(self) -> dict[str, Any] | None:
        async with self._lock:
            job = self._get_active_job_locked()
            return None if job is None else job.to_dict()

    async def cancel_job(self, job_id: str) -> dict[str, Any]:
        async with self._lock:
            job = self._jobs.get(job_id)
            if job is None:
                raise KeyError(job_id)
            if job.state in {"completed", "failed", "cancelled"}:
                return job.to_dict()
            if job._task is not None and not job._task.done():
                job.state = "cancelling"
                job._cancel_event.set()
            return job.to_dict()

    async def _run_job(self, job: IngestJobRecord) -> None:
        async with self._lock:
            job.state = "running"
            job.started_at = _utc_now()

        if job.job_type == "ingest":
            runner = self._ingest_factory
        elif job.job_type == "refresh":
            runner = self._refresh_factory
        else:
            runner = self._vectorize_factory

        try:
            summary = await runner(
                job.export_dir,
                job.options,
                job._cancel_event,
            )
        except asyncio.CancelledError:
            async with self._lock:
                job.state = "cancelled"
                job.completed_at = _utc_now()
                job.error = "cancelled"
                if self._active_job_id == job.job_id:
                    self._active_job_id = None
            raise
        except Exception as exc:  # noqa: BLE001
            async with self._lock:
                job.state = "failed"
                job.completed_at = _utc_now()
                job.error = str(exc)
                if self._active_job_id == job.job_id:
                    self._active_job_id = None
        else:
            payload = summary.model_dump()
            async with self._lock:
                job.state = "completed"
                job.completed_at = _utc_now()
                job.run_id = payload.get("run_id")
                job.result_summary = payload
                if self._active_job_id == job.job_id:
                    self._active_job_id = None

    def _get_active_job_locked(self) -> IngestJobRecord | None:
        if not self._active_job_id:
            return None
        job = self._jobs.get(self._active_job_id)
        if job is None:
            self._active_job_id = None
            return None
        if job.state in {"completed", "failed", "cancelled"}:
            self._active_job_id = None
            return None
        return job
