from __future__ import annotations

import json
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any

from sfgraph.daemon import clear_daemon_metadata, start_daemon_subprocess


class DaemonClient:
    def __init__(self, base_url: str, data_root: Path) -> None:
        self.base_url = base_url.rstrip("/")
        self.data_root = data_root

    def _post(self, path: str, payload: dict[str, Any]) -> dict[str, Any]:
        request = urllib.request.Request(
            url=f"{self.base_url}{path}",
            data=json.dumps(payload).encode("utf-8"),
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        with urllib.request.urlopen(request, timeout=3600) as response:
            body = json.loads(response.read().decode("utf-8"))
        if not isinstance(body, dict):
            raise RuntimeError("Invalid daemon response")
        if not body.get("ok"):
            raise RuntimeError(str(body))
        return body["result"]

    def _get(self, path: str) -> dict[str, Any]:
        with urllib.request.urlopen(f"{self.base_url}{path}", timeout=5) as response:
            body = json.loads(response.read().decode("utf-8"))
        if not isinstance(body, dict):
            raise RuntimeError("Invalid daemon response")
        return body

    def health(self) -> dict[str, Any]:
        return self._get("/health")

    def call(self, method: str, **params: Any) -> dict[str, Any]:
        return self._post(f"/rpc/{method}", params)


def ensure_daemon_client(data_root: Path, workspace_root: Path | None = None) -> DaemonClient:
    last_error: urllib.error.URLError | None = None
    for attempt in range(2):
        meta = start_daemon_subprocess(data_root, workspace_root=workspace_root, ignore_existing=attempt > 0)
        client = DaemonClient(str(meta["base_url"]), data_root)
        try:
            client.health()
            return client
        except urllib.error.URLError as exc:
            last_error = exc
            clear_daemon_metadata(data_root)
    assert last_error is not None
    raise RuntimeError(f"Failed to connect to sfgraph daemon at {meta['base_url']}: {last_error}") from last_error
