"""
NodeParserPool — asyncio subprocess pool for Node.js WASM parser workers.

Manages persistent Node.js worker subprocesses, dispatches parse requests
with timeout enforcement, and runs background health checks with automatic
worker replacement.

Requirements: POOL-03, POOL-04, POOL-06
"""
from __future__ import annotations

import asyncio
import dataclasses
import json
import os
import shutil
import sys
from pathlib import Path
from uuid import uuid4

# Module-level constants
NODE_BINARY = "/opt/homebrew/opt/node@22/bin/node"
WORKER_JS = str(Path(__file__).parent / "worker" / "worker.js")


def _resolve_node() -> str:
    """Resolve the Node.js binary path.

    Returns the configured NODE_BINARY if it exists, otherwise falls back
    to shutil.which('node').

    Raises:
        RuntimeError: If no Node.js binary can be found.
    """
    if Path(NODE_BINARY).exists():
        return NODE_BINARY
    fallback = shutil.which("node")
    if fallback:
        return fallback
    raise RuntimeError(
        f"Node.js binary not found. Tried: {NODE_BINARY!r} and shutil.which('node'). "
        "Install Node.js 22 LTS via: brew install node@22"
    )


@dataclasses.dataclass
class _Worker:
    """Represents a single persistent Node.js worker subprocess."""

    proc: asyncio.subprocess.Process
    semaphore: asyncio.Semaphore = dataclasses.field(
        default_factory=lambda: asyncio.Semaphore(1)
    )
    healthy: bool = True


class NodeParserPool:
    """Asyncio pool of persistent Node.js WASM parser worker subprocesses.

    Each worker runs worker.js and communicates via newline-delimited JSON
    over stdin/stdout. The pool manages worker lifecycle, health checks, and
    request dispatching with timeout enforcement.

    Usage:
        pool = NodeParserPool(size=4)
        await pool.start()
        try:
            result = await pool.parse("MyClass.cls", "apex", source_code)
        finally:
            await pool.shutdown()
    """

    def __init__(self, size: int | None = None) -> None:
        """Initialize the pool.

        Args:
            size: Number of worker subprocesses. Defaults to min(cpu_count, 8).
        """
        self._size: int = size or min(os.cpu_count() or 4, 8)
        self._workers: list[_Worker] = []
        self._health_task: asyncio.Task | None = None
        self._shutdown: bool = False

    async def start(self) -> None:
        """Spawn all workers and start the background health loop.

        Must be called before parse(). Workers are ready immediately after this
        returns — the health loop begins checking after the first 30s delay.
        """
        node_bin = _resolve_node()
        for _ in range(self._size):
            worker = await self._spawn_worker(node_bin)
            self._workers.append(worker)
        self._health_task = asyncio.create_task(self._health_loop())

    async def _spawn_worker(self, node_bin: str | None = None) -> _Worker:
        """Spawn a single Node.js worker subprocess.

        Args:
            node_bin: Path to the Node.js binary. Resolved if not provided.

        Returns:
            A new _Worker wrapping the subprocess.
        """
        if node_bin is None:
            node_bin = _resolve_node()
        proc = await asyncio.create_subprocess_exec(
            node_bin,
            WORKER_JS,
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            cwd=str(Path(WORKER_JS).parent.parent.parent.parent.parent),
        )
        return _Worker(proc=proc)

    async def parse(
        self, file_path: str, grammar: str, file_content: str
    ) -> dict:
        """Dispatch a parse request to an available worker.

        Finds the first healthy worker whose semaphore is not locked.
        Falls back to workers[0] if all are busy.

        Args:
            file_path: Path to the file being parsed (for IPC context).
            grammar: Grammar name, e.g. "apex".
            file_content: Source code to parse.

        Returns:
            IPC response dict with keys: ok, payload, error, requestId.
        """
        # Find first healthy, not-locked worker
        chosen: _Worker | None = None
        for w in self._workers:
            if w.healthy and not w.semaphore.locked():
                chosen = w
                break

        # Fallback: use first worker if all are busy or unhealthy
        if chosen is None and self._workers:
            chosen = self._workers[0]

        if chosen is None:
            return {"ok": False, "error": "no_workers", "payload": None}

        async with chosen.semaphore:
            return await self._dispatch(chosen, file_path, grammar, file_content)

    async def _dispatch(
        self, worker: _Worker, file_path: str, grammar: str, content: str
    ) -> dict:
        """Send a parse request to a specific worker and await its response.

        Enforces a 10-second timeout. On timeout, schedules worker replacement
        to avoid stale response contamination on the next request.

        Args:
            worker: The worker to dispatch to.
            file_path: File path for IPC context.
            grammar: Grammar name.
            content: Source code content.

        Returns:
            IPC response dict.
        """
        request_id = str(uuid4())
        request = {
            "requestId": request_id,
            "grammar": grammar,
            "filePath": file_path,
            "fileContent": content,
        }
        line = json.dumps(request) + "\n"
        worker.proc.stdin.write(line.encode())
        await worker.proc.stdin.drain()

        try:
            raw = await asyncio.wait_for(
                worker.proc.stdout.readline(), timeout=10.0
            )
        except asyncio.TimeoutError:
            # Schedule worker replacement to avoid stale response contamination
            asyncio.create_task(self._replace_worker(worker))
            return {"ok": False, "error": "timeout", "payload": None}

        if not raw:
            # Worker process exited unexpectedly
            asyncio.create_task(self._replace_worker(worker))
            return {"ok": False, "error": "worker_exited", "payload": None}

        try:
            response = json.loads(raw.decode())
        except json.JSONDecodeError:
            asyncio.create_task(self._replace_worker(worker))
            return {"ok": False, "error": "invalid_json", "payload": None}

        # Handle voluntary memory_ceiling exit from worker
        if not response.get("ok") and response.get("error") == "memory_ceiling":
            asyncio.create_task(self._replace_worker(worker))
            return {"ok": False, "error": "worker_restarting", "payload": None}

        return response

    async def _health_loop(self) -> None:
        """Background task: ping all workers every 30 seconds.

        Unhealthy workers (no pong within 5s) are replaced automatically.
        Loop exits cleanly when shutdown() sets self._shutdown = True.
        """
        while not self._shutdown:
            await asyncio.sleep(30)
            if self._shutdown:
                break
            for worker in list(self._workers):
                if worker.healthy:
                    alive = await self._ping_worker(worker)
                    if not alive:
                        asyncio.create_task(self._replace_worker(worker))

    async def _ping_worker(self, worker: _Worker) -> bool:
        """Send a ping to a worker and wait for a pong response.

        Args:
            worker: The worker to ping.

        Returns:
            True if the worker responded with type=="pong", False otherwise.
        """
        request_id = str(uuid4())
        request = {"requestId": request_id, "type": "ping"}
        line = json.dumps(request) + "\n"
        try:
            worker.proc.stdin.write(line.encode())
            await worker.proc.stdin.drain()
            raw = await asyncio.wait_for(
                worker.proc.stdout.readline(), timeout=5.0
            )
            if not raw:
                return False
            response = json.loads(raw.decode())
            return response.get("type") == "pong"
        except Exception:
            return False

    async def _replace_worker(self, old_worker: _Worker) -> None:
        """Kill an unhealthy worker and replace it with a fresh one.

        The new worker occupies the same index in self._workers so that
        existing references to the list still resolve correctly.

        Args:
            old_worker: The worker to replace.
        """
        # Find index before marking unhealthy
        try:
            idx = self._workers.index(old_worker)
        except ValueError:
            return  # Already replaced

        old_worker.healthy = False

        # Kill the old process
        try:
            old_worker.proc.kill()
        except ProcessLookupError:
            pass  # Already dead

        try:
            await old_worker.proc.wait()
        except Exception:
            pass

        if self._shutdown:
            return

        # Spawn replacement
        new_worker = await self._spawn_worker()
        self._workers[idx] = new_worker

    async def shutdown(self) -> None:
        """Terminate all worker processes and cancel the health loop.

        Safe to call multiple times. Blocks until all worker processes exit.
        """
        self._shutdown = True

        if self._health_task is not None and not self._health_task.done():
            self._health_task.cancel()
            try:
                await self._health_task
            except asyncio.CancelledError:
                pass

        for worker in self._workers:
            try:
                worker.proc.kill()
            except ProcessLookupError:
                pass  # Already dead
            try:
                await worker.proc.wait()
            except Exception:
                pass
