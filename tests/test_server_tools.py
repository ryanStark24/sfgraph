from __future__ import annotations

import json
from pathlib import Path
from types import SimpleNamespace

import pytest

from sfgraph import server


class _FakeDaemon:
    def __init__(self) -> None:
        self.calls: list[tuple[str, dict]] = []

    def call(self, method: str, **params):
        self.calls.append((method, params))
        return {"method": method, "params": params}


def _ctx(daemon: _FakeDaemon):
    app = SimpleNamespace(daemon=daemon, data_root=Path("/tmp/data"))
    return SimpleNamespace(request_context=SimpleNamespace(lifespan_context=app))


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("tool", "method", "kwargs"),
    [
        (server.ingest_org, "ingest_org", {"mode": "full"}),
        (server.start_ingest_job, "start_ingest_job", {"mode": "graph_only"}),
        (server.refresh, "refresh", {"mode": "full"}),
        (server.vectorize, "vectorize", {}),
        (
            server.watch_refresh,
            "watch_refresh",
            {
                "duration_seconds": 1,
                "poll_interval": 0.1,
                "debounce_seconds": 0.1,
                "max_refreshes": 1,
            },
        ),
    ],
)
async def test_tools_proxy_to_daemon(
    tool,
    method,
    kwargs,
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
):
    workspace = tmp_path / "repo"
    workspace.mkdir(parents=True, exist_ok=True)
    monkeypatch.chdir(workspace)
    daemon = _FakeDaemon()

    payload = await tool(str(workspace), _ctx(daemon), **kwargs)

    assert json.loads(payload)["method"] == method
    assert daemon.calls[0][0] == method
    assert daemon.calls[0][1]["export_dir"] == str(workspace.resolve())


@pytest.mark.asyncio
async def test_non_export_tools_proxy_to_daemon():
    daemon = _FakeDaemon()
    payload = await server.get_ingestion_status(_ctx(daemon))
    assert json.loads(payload)["method"] == "get_ingestion_status"


@pytest.mark.asyncio
async def test_export_path_guard_still_applies(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    workspace = tmp_path / "repo"
    outside = tmp_path / "outside"
    workspace.mkdir(parents=True, exist_ok=True)
    outside.mkdir(parents=True, exist_ok=True)
    monkeypatch.chdir(workspace)
    daemon = _FakeDaemon()

    with pytest.raises(ValueError):
        await server.ingest_org(str(outside), _ctx(daemon), mode="full")
