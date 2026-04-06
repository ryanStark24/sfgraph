# src/sfgraph/storage/manifest_store.py
"""SQLite-backed ManifestStore for crash-recovery and incremental ingestion.

Tracks per-file processing state through the two-phase ingestion pipeline:
  PENDING -> NODES_WRITTEN -> EDGES_WRITTEN

Also tracks ingestion runs with phase completion flags for safe resume.
"""
import hashlib
import time
import uuid
from typing import Any, Dict

import aiosqlite

# Valid phase state machine transitions
VALID_STATUSES = frozenset({"PENDING", "NODES_WRITTEN", "EDGES_WRITTEN", "FAILED"})

_SCHEMA = """
CREATE TABLE IF NOT EXISTS files (
    path            TEXT PRIMARY KEY,
    sha256          TEXT NOT NULL,
    status          TEXT NOT NULL DEFAULT 'PENDING',
    run_id          TEXT,
    last_ingested_at REAL
);

CREATE TABLE IF NOT EXISTS runs (
    run_id          TEXT PRIMARY KEY,
    started_at      REAL NOT NULL,
    completed_at    REAL,
    phase_1_complete INTEGER NOT NULL DEFAULT 0,
    phase_2_complete INTEGER NOT NULL DEFAULT 0,
    status          TEXT NOT NULL DEFAULT 'RUNNING'
);
"""


class ManifestStore:
    """SQLite-backed manifest for tracking file ingestion state."""

    def __init__(self, db_path: str) -> None:
        self._db_path = db_path
        self._conn: aiosqlite.Connection | None = None

    async def initialize(self) -> None:
        """Open the database and create tables if they do not exist."""
        self._conn = await aiosqlite.connect(self._db_path)
        await self._conn.executescript(_SCHEMA)
        await self._conn.commit()

    async def upsert_file(self, path: str, sha256: str, run_id: str) -> None:
        """Insert or update a file record, always resetting status to PENDING.

        This is intentional: any re-ingestion starts fresh so the two-phase
        pipeline processes the file from the beginning.
        """
        await self._conn.execute(
            """
            INSERT INTO files (path, sha256, status, run_id, last_ingested_at)
            VALUES (?, ?, 'PENDING', ?, ?)
            ON CONFLICT(path) DO UPDATE SET
                sha256 = excluded.sha256,
                status = 'PENDING',
                run_id = excluded.run_id,
                last_ingested_at = excluded.last_ingested_at
            """,
            (path, sha256, run_id, time.time()),
        )
        await self._conn.commit()

    async def set_status(self, path: str, status: str) -> None:
        """Advance the phase state machine for a file.

        Args:
            path: Absolute or project-relative path of the file.
            status: One of PENDING, NODES_WRITTEN, EDGES_WRITTEN, FAILED.
        """
        if status not in VALID_STATUSES:
            raise ValueError(f"Invalid status: {status!r}. Must be one of {VALID_STATUSES}.")
        await self._conn.execute(
            "UPDATE files SET status = ? WHERE path = ?",
            (status, path),
        )
        await self._conn.commit()

    async def get_delta(
        self, current_files: Dict[str, str]
    ) -> Dict[str, list]:
        """Compute the delta between current disk state and stored manifest.

        Only considers files that reached EDGES_WRITTEN in the stored manifest
        (i.e. fully processed in a previous run).

        Args:
            current_files: Mapping of path -> sha256 for files currently on disk.

        Returns:
            dict with keys "new", "changed", "unchanged", "deleted".
        """
        cursor = await self._conn.execute(
            "SELECT path, sha256 FROM files WHERE status = 'EDGES_WRITTEN'"
        )
        rows = await cursor.fetchall()
        stored: Dict[str, str] = {row[0]: row[1] for row in rows}

        new: list = []
        changed: list = []
        unchanged: list = []
        deleted: list = []

        for path, sha in current_files.items():
            if path not in stored:
                new.append(path)
            elif stored[path] != sha:
                changed.append(path)
            else:
                unchanged.append(path)

        for path in stored:
            if path not in current_files:
                deleted.append(path)

        return {"new": new, "changed": changed, "unchanged": unchanged, "deleted": deleted}

    async def create_run(self) -> str:
        """Create a new ingestion run record and return its run_id."""
        run_id = str(uuid.uuid4())
        await self._conn.execute(
            "INSERT INTO runs (run_id, started_at) VALUES (?, ?)",
            (run_id, time.time()),
        )
        await self._conn.commit()
        return run_id

    async def mark_run_complete(
        self,
        run_id: str,
        *,
        phase_1_complete: bool = False,
        phase_2_complete: bool = False,
    ) -> None:
        """Mark a run as completed and record phase completion flags."""
        await self._conn.execute(
            """
            UPDATE runs
            SET completed_at = ?,
                phase_1_complete = ?,
                phase_2_complete = ?,
                status = 'COMPLETED'
            WHERE run_id = ?
            """,
            (time.time(), int(phase_1_complete), int(phase_2_complete), run_id),
        )
        await self._conn.commit()

    async def get_status_counts(self) -> dict[str, int]:
        """Return counts of files by ingestion status."""
        cursor = await self._conn.execute(
            "SELECT status, COUNT(*) FROM files GROUP BY status"
        )
        rows = await cursor.fetchall()
        counts = {status: count for status, count in rows}
        for status in VALID_STATUSES:
            counts.setdefault(status, 0)
        return counts

    async def get_pending_files(self, limit: int = 200) -> list[str]:
        """Return files that are not yet fully ingested (status != EDGES_WRITTEN)."""
        cursor = await self._conn.execute(
            """
            SELECT path
            FROM files
            WHERE status != 'EDGES_WRITTEN'
            ORDER BY path
            LIMIT ?
            """,
            (limit,),
        )
        rows = await cursor.fetchall()
        return [row[0] for row in rows]

    async def get_latest_completed_run(self) -> dict[str, Any] | None:
        """Return metadata for the most recently completed run, if any."""
        cursor = await self._conn.execute(
            """
            SELECT run_id, started_at, completed_at, phase_1_complete, phase_2_complete, status
            FROM runs
            WHERE completed_at IS NOT NULL
            ORDER BY completed_at DESC
            LIMIT 1
            """
        )
        row = await cursor.fetchone()
        if row is None:
            return None
        return {
            "run_id": row[0],
            "started_at": row[1],
            "completed_at": row[2],
            "phase_1_complete": bool(row[3]),
            "phase_2_complete": bool(row[4]),
            "status": row[5],
        }

    async def delete_files(self, paths: list[str]) -> int:
        """Delete file manifest entries. Returns deleted row count."""
        if not paths:
            return 0
        cursor = await self._conn.executemany(
            "DELETE FROM files WHERE path = ?",
            [(path,) for path in paths],
        )
        await self._conn.commit()
        # sqlite3 cursor.rowcount can be -1 for executemany; compute explicitly.
        verify = await self._conn.execute(
            "SELECT COUNT(*) FROM files WHERE path IN (%s)" % ",".join("?" * len(paths)),
            paths,
        )
        remaining = (await verify.fetchone())[0]
        return len(paths) - int(remaining)

    @staticmethod
    def compute_sha256(path: str) -> str:
        """Compute the SHA-256 hex digest of a file, reading in 64 KiB chunks.

        Returns:
            64-character lowercase hexadecimal string.
        """
        h = hashlib.sha256()
        with open(path, "rb") as f:
            while chunk := f.read(65536):
                h.update(chunk)
        return h.hexdigest()

    async def close(self) -> None:
        """Close the database connection."""
        if self._conn is not None:
            await self._conn.close()
            self._conn = None
