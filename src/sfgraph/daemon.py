from __future__ import annotations

import argparse
import asyncio
import json
import logging
import os
import signal
import socket
import subprocess
import sys
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any

from sfgraph.daemon_service import DaemonOperations, close_app_context, create_app_context

logger = logging.getLogger(__name__)
_DEFAULT_HOST = "127.0.0.1"


def _daemon_meta_path(data_root: Path) -> Path:
    return data_root / "daemon.json"


def _is_process_alive(pid: int) -> bool:
    try:
        os.kill(pid, 0)
        return True
    except OSError:
        return False


def _free_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.bind((_DEFAULT_HOST, 0))
        sock.listen(1)
        return int(sock.getsockname()[1])


class _DaemonHandler(BaseHTTPRequestHandler):
    server_version = "sfgraphd/0.1"

    def _send_json(self, status: int, payload: dict[str, Any]) -> None:
        body = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, format: str, *args: object) -> None:  # noqa: A003
        logger.info("daemon http: " + format, *args)

    def do_GET(self) -> None:  # noqa: N802
        if self.path == "/health":
            self._send_json(200, {"ok": True, "pid": os.getpid()})
            return
        if self.path == "/meta":
            self._send_json(200, getattr(self.server, "meta_payload"))
            return
        if self.path == "/progress-snapshot":
            progress_path = Path(getattr(self.server, "data_root")) / "ingestion_progress.json"
            if not progress_path.exists():
                self._send_json(200, {"available": False, "state": "idle"})
                return
            try:
                payload = json.loads(progress_path.read_text(encoding="utf-8"))
            except Exception:
                self._send_json(200, {"available": False, "state": "idle"})
                return
            if not isinstance(payload, dict):
                self._send_json(200, {"available": False, "state": "idle"})
                return
            payload = dict(payload)
            payload["available"] = True
            self._send_json(200, payload)
            return
        self._send_json(404, {"error": "not_found"})

    def do_POST(self) -> None:  # noqa: N802
        if not self.path.startswith("/rpc/"):
            self._send_json(404, {"error": "not_found"})
            return
        content_length = int(self.headers.get("Content-Length", "0") or "0")
        raw = self.rfile.read(content_length) if content_length else b"{}"
        try:
            payload = json.loads(raw.decode("utf-8") or "{}")
        except Exception:
            self._send_json(400, {"error": "invalid_json"})
            return
        if not isinstance(payload, dict):
            self._send_json(400, {"error": "invalid_payload"})
            return
        method = self.path.split("/rpc/", 1)[1]
        loop = getattr(self.server, "loop")
        ops = getattr(self.server, "operations")
        future = asyncio.run_coroutine_threadsafe(ops.dispatch(method, payload), loop)
        try:
            result = future.result(timeout=3600)
        except KeyError:
            self._send_json(404, {"error": "unknown_method", "method": method})
            return
        except Exception as exc:  # noqa: BLE001
            logger.exception("daemon rpc failed for %s", method)
            self._send_json(500, {"error": type(exc).__name__, "message": str(exc)})
            return
        self._send_json(200, {"ok": True, "result": result})


class _DaemonServer(ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = True


async def run_daemon(data_root: Path, host: str, port: int) -> None:
    app = await create_app_context(data_root)
    loop = asyncio.get_running_loop()
    server = _DaemonServer((host, port), _DaemonHandler)
    meta = {
        "host": host,
        "port": port,
        "base_url": f"http://{host}:{port}",
        "pid": os.getpid(),
        "data_root": str(data_root),
    }
    meta_path = _daemon_meta_path(data_root)
    server.loop = loop  # type: ignore[attr-defined]
    server.operations = DaemonOperations(app)  # type: ignore[attr-defined]
    server.meta_payload = meta  # type: ignore[attr-defined]
    server.data_root = str(data_root)  # type: ignore[attr-defined]

    thread = threading.Thread(target=server.serve_forever, name="sfgraphd-http", daemon=True)
    thread.start()
    meta_path.write_text(json.dumps(meta, indent=2), encoding="utf-8")
    logger.info("sfgraph daemon listening on %s", meta["base_url"])

    stop_event = asyncio.Event()

    def _handle_stop(*_args: object) -> None:
        stop_event.set()

    for sig in (signal.SIGTERM, signal.SIGINT):
        try:
            loop.add_signal_handler(sig, _handle_stop)
        except NotImplementedError:
            pass

    try:
        await stop_event.wait()
    finally:
        server.shutdown()
        thread.join(timeout=5)
        server.server_close()
        await close_app_context(app)
        try:
            meta_path.unlink(missing_ok=True)
        except Exception:
            pass


def clear_daemon_metadata(data_root: Path) -> None:
    meta_path = _daemon_meta_path(data_root.expanduser().resolve())
    try:
        meta_path.unlink(missing_ok=True)
    except Exception:
        logger.warning("Failed to remove stale daemon metadata at %s", meta_path, exc_info=True)


def start_daemon_subprocess(
    data_root: Path,
    host: str = _DEFAULT_HOST,
    *,
    ignore_existing: bool = False,
) -> dict[str, Any]:
    data_root = data_root.expanduser().resolve()
    meta_path = _daemon_meta_path(data_root)
    if not ignore_existing and meta_path.exists():
        try:
            meta = json.loads(meta_path.read_text(encoding="utf-8"))
            pid = int(meta.get("pid", 0))
            if pid and _is_process_alive(pid):
                return meta
        except Exception:
            pass
    elif ignore_existing:
        clear_daemon_metadata(data_root)
    port = _free_port()
    env = os.environ.copy()
    env["SFGRAPH_DATA_DIR"] = str(data_root)
    cmd = [sys.executable, "-m", "sfgraph.daemon", "--data-dir", str(data_root), "--host", host, "--port", str(port)]
    subprocess.Popen(cmd, env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, start_new_session=True)
    for _ in range(50):
        if meta_path.exists():
            try:
                meta = json.loads(meta_path.read_text(encoding="utf-8"))
                if int(meta.get("port", 0)) == port:
                    return meta
            except Exception:
                pass
        import time
        time.sleep(0.1)
    raise RuntimeError(f"Timed out starting sfgraph daemon for {data_root}")


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(prog="sfgraphd", description="Local sfgraph daemon")
    parser.add_argument("--data-dir", default=os.getenv("SFGRAPH_DATA_DIR", "./data"))
    parser.add_argument("--host", default=_DEFAULT_HOST)
    parser.add_argument("--port", type=int, required=True)
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    logging.basicConfig(stream=sys.stderr, level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
    args = parse_args(argv)
    data_root = Path(args.data_dir).expanduser().resolve()
    asyncio.run(run_daemon(data_root=data_root, host=args.host, port=args.port))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
