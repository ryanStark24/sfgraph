"""Background ingest job management for MCP-friendly polling."""
from __future__ import annotations

import asyncio
import json
import threading
import uuid
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any, Awaitable, Callable

import aiosqlite

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
        db_path: str | None = None,
    ) -> None:
        self._ingest_factory = ingest_factory
        self._refresh_factory = refresh_factory
        self._vectorize_factory = vectorize_factory
        self._jobs: dict[str, IngestJobRecord] = {}
        self._active_job_id: str | None = None
        self._lock = asyncio.Lock()
        self._db_path = db_path
        self._db: aiosqlite.Connection | None = None
        self._initialized = db_path is None

    @property
    def active_job_id(self) -> str | None:
        return self._active_job_id

    async def initialize(self) -> None:
        if self._initialized:
            return
        if not self._db_path:
            self._initialized = True
            return
        self._db = await aiosqlite.connect(self._db_path)
        await self._db.execute(
            """
            CREATE TABLE IF NOT EXISTS ingest_jobs (
                job_id TEXT PRIMARY KEY,
                job_type TEXT NOT NULL,
                export_dir TEXT NOT NULL,
                state TEXT NOT NULL,
                created_at TEXT NOT NULL,
                started_at TEXT,
                completed_at TEXT,
                error TEXT,
                run_id TEXT,
                options_json TEXT NOT NULL,
                result_summary_json TEXT,
                updated_at TEXT NOT NULL
            )
            """
        )
        await self._db.execute(
            """
            CREATE TABLE IF NOT EXISTS ingest_job_state (
                key TEXT PRIMARY KEY,
                value TEXT
            )
            """
        )
        await self._db.commit()
        await self._load_state_from_db()
        self._initialized = True

    async def close(self) -> None:
        if self._db is not None:
            await self._db.close()
            self._db = None

    async def _ensure_initialized(self) -> None:
        if not self._initialized:
            await self.initialize()

    async def _load_state_from_db(self) -> None:
        if self._db is None:
            return
        cursor = await self._db.execute(
            """
            SELECT job_id, job_type, export_dir, state, created_at, started_at, completed_at,
                   error, run_id, options_json, result_summary_json
            FROM ingest_jobs
            ORDER BY created_at DESC
            """
        )
        rows = await cursor.fetchall()
        await cursor.close()
        for row in rows:
            (
                job_id,
                job_type,
                export_dir,
                state,
                created_at,
                started_at,
                completed_at,
                error,
                run_id,
                options_json,
                result_summary_json,
            ) = row
            options = {}
            summary = None
            try:
                options = json.loads(options_json or "{}")
                if not isinstance(options, dict):
                    options = {}
            except Exception:
                options = {}
            try:
                raw_summary = json.loads(result_summary_json) if result_summary_json else None
                summary = raw_summary if isinstance(raw_summary, dict) else None
            except Exception:
                summary = None
            self._jobs[str(job_id)] = IngestJobRecord(
                job_id=str(job_id),
                job_type=str(job_type),
                export_dir=str(export_dir),
                state=str(state),
                created_at=str(created_at),
                started_at=str(started_at) if started_at else None,
                completed_at=str(completed_at) if completed_at else None,
                error=str(error) if error else None,
                run_id=str(run_id) if run_id else None,
                options=options,
                result_summary=summary,
            )

        active_cursor = await self._db.execute(
            "SELECT value FROM ingest_job_state WHERE key = 'active_job_id' LIMIT 1"
        )
        active_row = await active_cursor.fetchone()
        await active_cursor.close()
        self._active_job_id = str(active_row[0]) if active_row and active_row[0] else None

        # Jobs cannot resume across daemon restarts. Mark prior active/running jobs failed.
        for job in self._jobs.values():
            if job.state in {"queued", "running", "cancelling"}:
                job.state = "failed"
                job.completed_at = job.completed_at or _utc_now()
                job.error = job.error or "daemon_restarted"
                await self._persist_job_locked(job)
        active = self._get_active_job_locked()
        await self._persist_active_job_locked(active.job_id if active else None)

    async def _persist_active_job_locked(self, job_id: str | None) -> None:
        if self._db is None:
            return
        await self._db.execute(
            """
            INSERT INTO ingest_job_state (key, value)
            VALUES ('active_job_id', ?)
            ON CONFLICT(key) DO UPDATE SET value = excluded.value
            """,
            (job_id,),
        )
        await self._db.commit()

    async def _persist_job_locked(self, job: IngestJobRecord) -> None:
        if self._db is None:
            return
        await self._db.execute(
            """
            INSERT INTO ingest_jobs (
                job_id, job_type, export_dir, state, created_at, started_at, completed_at,
                error, run_id, options_json, result_summary_json, updated_at
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(job_id) DO UPDATE SET
                job_type = excluded.job_type,
                export_dir = excluded.export_dir,
                state = excluded.state,
                created_at = excluded.created_at,
                started_at = excluded.started_at,
                completed_at = excluded.completed_at,
                error = excluded.error,
                run_id = excluded.run_id,
                options_json = excluded.options_json,
                result_summary_json = excluded.result_summary_json,
                updated_at = excluded.updated_at
            """,
            (
                job.job_id,
                job.job_type,
                job.export_dir,
                job.state,
                job.created_at,
                job.started_at,
                job.completed_at,
                job.error,
                job.run_id,
                json.dumps(job.options or {}),
                json.dumps(job.result_summary) if job.result_summary is not None else None,
                _utc_now(),
            ),
        )
        await self._db.commit()

    async def start_job(
        self,
        *,
        job_type: str,
        export_dir: str,
        options: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        """Start an ingest or refresh in the background."""
        await self._ensure_initialized()
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
            await self._persist_job_locked(job)
            await self._persist_active_job_locked(job.job_id)
            job._task = asyncio.create_task(self._run_job(job), name=f"sfgraph-{job_type}-{job.job_id}")
            return job.to_dict()

    async def list_jobs(self) -> list[dict[str, Any]]:
        await self._ensure_initialized()
        async with self._lock:
            jobs = sorted(
                (job.to_dict() for job in self._jobs.values()),
                key=lambda payload: payload["created_at"],
                reverse=True,
            )
        return jobs

    async def get_job(self, job_id: str) -> dict[str, Any] | None:
        await self._ensure_initialized()
        async with self._lock:
            job = self._jobs.get(job_id)
            return None if job is None else job.to_dict()

    async def get_active_job(self) -> dict[str, Any] | None:
        await self._ensure_initialized()
        async with self._lock:
            job = self._get_active_job_locked()
            return None if job is None else job.to_dict()

    async def cancel_job(self, job_id: str) -> dict[str, Any]:
        await self._ensure_initialized()
        async with self._lock:
            job = self._jobs.get(job_id)
            if job is None:
                raise KeyError(job_id)
            if job.state in {"completed", "failed", "cancelled"}:
                return job.to_dict()
            if job._task is not None and not job._task.done():
                job.state = "cancelling"
                job._cancel_event.set()
                await self._persist_job_locked(job)
            return job.to_dict()

    async def _run_job(self, job: IngestJobRecord) -> None:
        async with self._lock:
            job.state = "running"
            job.started_at = _utc_now()
            await self._persist_job_locked(job)

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
                await self._persist_job_locked(job)
                await self._persist_active_job_locked(self._active_job_id)
            raise
        except Exception as exc:  # noqa: BLE001
            async with self._lock:
                job.state = "failed"
                job.completed_at = _utc_now()
                job.error = str(exc)
                if self._active_job_id == job.job_id:
                    self._active_job_id = None
                await self._persist_job_locked(job)
                await self._persist_active_job_locked(self._active_job_id)
        else:
            payload = summary.model_dump()
            async with self._lock:
                job.state = "completed"
                job.completed_at = _utc_now()
                job.run_id = payload.get("run_id")
                job.result_summary = payload
                if self._active_job_id == job.job_id:
                    self._active_job_id = None
                await self._persist_job_locked(job)
                await self._persist_active_job_locked(self._active_job_id)

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
