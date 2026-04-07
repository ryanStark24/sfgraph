from __future__ import annotations

import urllib.error
from pathlib import Path

from sfgraph.daemon_client import DaemonClient, ensure_daemon_client


def test_ensure_daemon_client_retries_after_stale_metadata(monkeypatch, tmp_path: Path):
    starts: list[bool] = []
    cleared: list[Path] = []
    health_calls: list[str] = []

    def fake_start_daemon_subprocess(data_root: Path, host: str = "127.0.0.1", *, ignore_existing: bool = False):
        starts.append(ignore_existing)
        port = 1111 if not ignore_existing else 2222
        return {"base_url": f"http://127.0.0.1:{port}", "pid": 123, "data_root": str(data_root)}

    def fake_clear_daemon_metadata(data_root: Path) -> None:
        cleared.append(data_root)

    def fake_health(self: DaemonClient):
        health_calls.append(self.base_url)
        if self.base_url.endswith(":1111"):
            raise urllib.error.URLError("timed out")
        return {"ok": True}

    monkeypatch.setattr("sfgraph.daemon_client.start_daemon_subprocess", fake_start_daemon_subprocess)
    monkeypatch.setattr("sfgraph.daemon_client.clear_daemon_metadata", fake_clear_daemon_metadata)
    monkeypatch.setattr(DaemonClient, "health", fake_health)

    client = ensure_daemon_client(tmp_path)

    assert client.base_url == "http://127.0.0.1:2222"
    assert starts == [False, True]
    assert cleared == [tmp_path]
    assert health_calls == ["http://127.0.0.1:1111", "http://127.0.0.1:2222"]
