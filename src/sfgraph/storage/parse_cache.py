"""Local content-addressed parse cache for repeated ingests."""
from __future__ import annotations

import json
import time
from typing import Any

import aiosqlite

_SCHEMA = """
CREATE TABLE IF NOT EXISTS parse_cache (
    parser_name     TEXT NOT NULL,
    sha256          TEXT NOT NULL,
    cache_version   TEXT NOT NULL,
    payload_json    TEXT NOT NULL,
    created_at      REAL NOT NULL,
    PRIMARY KEY (parser_name, sha256, cache_version)
);
"""


class ParseCache:
    """SQLite-backed parse-result cache keyed by parser + file hash."""

    CACHE_VERSION = "v1"

    def __init__(self, db_path: str) -> None:
        self._db_path = db_path
        self._conn: aiosqlite.Connection | None = None

    async def initialize(self) -> None:
        self._conn = await aiosqlite.connect(self._db_path)
        await self._conn.executescript(_SCHEMA)
        await self._conn.commit()

    async def get(self, parser_name: str, sha256: str) -> dict[str, Any] | None:
        cursor = await self._conn.execute(
            """
            SELECT payload_json
            FROM parse_cache
            WHERE parser_name = ? AND sha256 = ? AND cache_version = ?
            """,
            (parser_name, sha256, self.CACHE_VERSION),
        )
        row = await cursor.fetchone()
        if row is None:
            return None
        try:
            payload = json.loads(str(row[0]))
        except Exception:
            return None
        return payload if isinstance(payload, dict) else None

    async def put(self, parser_name: str, sha256: str, payload: dict[str, Any]) -> None:
        await self._conn.execute(
            """
            INSERT INTO parse_cache (parser_name, sha256, cache_version, payload_json, created_at)
            VALUES (?, ?, ?, ?, ?)
            ON CONFLICT(parser_name, sha256, cache_version) DO UPDATE SET
                payload_json = excluded.payload_json,
                created_at = excluded.created_at
            """,
            (parser_name, sha256, self.CACHE_VERSION, json.dumps(payload), time.time()),
        )
        await self._conn.commit()

    async def close(self) -> None:
        if self._conn is not None:
            await self._conn.close()
            self._conn = None
