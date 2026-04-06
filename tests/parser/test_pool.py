"""
Integration tests for NodeParserPool (POOL-03, POOL-04, POOL-06).

These tests spawn real Node.js worker subprocesses and verify the full
Python asyncio → Node.js IPC round-trip. Tests require Node.js 22 LTS.

Run with:
  export PATH="/Users/anshulmehta/.local/bin:/opt/homebrew/opt/node@22/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"
  uv run pytest tests/parser/test_pool.py -v -m integration
"""
import asyncio
from pathlib import Path

import pytest

from sfgraph.parser.pool import NodeParserPool

FIXTURES = Path(__file__).parent / "fixtures"
SIMPLE_CLS_PATH = str((FIXTURES / "simple.cls").resolve())
BROKEN_CLS_PATH = str((FIXTURES / "broken.cls").resolve())
SIMPLE_CLS = (FIXTURES / "simple.cls").read_text()
BROKEN_CLS = (FIXTURES / "broken.cls").read_text()


@pytest.mark.integration
@pytest.mark.asyncio
async def test_pool_starts_and_parses_apex_file():
    """Pool spawns worker(s), parse() returns ok:True for valid Apex."""
    pool = NodeParserPool(size=1)
    await pool.start()
    try:
        result = await pool.parse(SIMPLE_CLS_PATH, "apex")
        assert result["ok"] is True
        assert result["payload"] is not None
    finally:
        await pool.shutdown()


@pytest.mark.integration
@pytest.mark.asyncio
async def test_pool_parse_error_returns_ok_false():
    """parse() returns ok:False with error='parse_error' for broken Apex."""
    pool = NodeParserPool(size=1)
    await pool.start()
    try:
        result = await pool.parse(BROKEN_CLS_PATH, "apex")
        assert result["ok"] is False
        assert result["error"] == "parse_error"
    finally:
        await pool.shutdown()


@pytest.mark.integration
@pytest.mark.asyncio
async def test_pool_ping_health_check():
    """_ping_worker() returns True for a live worker."""
    pool = NodeParserPool(size=1)
    await pool.start()
    try:
        worker = pool._workers[0]
        is_alive = await pool._ping_worker(worker)
        assert is_alive is True
    finally:
        await pool.shutdown()


@pytest.mark.integration
@pytest.mark.asyncio
async def test_pool_shutdown_cleans_up():
    """After shutdown(), all worker processes are terminated (returncode is not None)."""
    pool = NodeParserPool(size=1)
    await pool.start()
    workers_snapshot = list(pool._workers)
    await pool.shutdown()
    for worker in workers_snapshot:
        assert worker.proc.returncode is not None, (
            f"Worker process {worker.proc.pid} still running after shutdown"
        )
