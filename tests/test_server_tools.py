from __future__ import annotations

import json
from pathlib import Path
from types import SimpleNamespace

import pytest

from sfgraph import server


class _FakeDaemon:
    def __init__(self, name: str = "default") -> None:
        self.calls: list[tuple[str, dict]] = []
        self.name = name

    def call(self, method: str, **params):
        self.calls.append((method, params))
        if method == "list_ingest_jobs":
            return {"active_job_id": None, "jobs": []}
        return {"method": method, "params": params, "daemon": self.name}


def _ctx(app):
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
    app = SimpleNamespace(
        runtime_root=tmp_path / "runtime" / "workspaces",
        session_data_root=tmp_path / "runtime" / "session" / "data",
        daemons={},
        job_routes={},
        active_export_dir=None,
    )
    created_data_roots: list[Path] = []

    def fake_ensure_daemon_client(data_root: Path, workspace_root: Path | None = None):
        created_data_roots.append(data_root)
        return daemon

    monkeypatch.setattr(server, "ensure_daemon_client", fake_ensure_daemon_client)

    payload = await tool(str(workspace), _ctx(app), **kwargs)

    assert json.loads(payload)["method"] == method
    assert daemon.calls[0][0] == method
    assert daemon.calls[0][1]["export_dir"] == str(workspace.resolve())
    assert created_data_roots
    assert created_data_roots[0].parent.name == server._workspace_key(str(workspace.resolve()))


@pytest.mark.asyncio
async def test_non_export_tools_proxy_to_daemon():
    export_dir = str(Path("/tmp/repo").resolve())
    daemon = _FakeDaemon()
    app = SimpleNamespace(
        runtime_root=Path("/tmp/runtime/workspaces"),
        session_data_root=Path("/tmp/runtime/session/data"),
        daemons={export_dir: daemon},
        job_routes={},
        active_export_dir=export_dir,
    )
    payload = await server.get_ingestion_status(_ctx(app))
    assert json.loads(payload)["method"] == "get_ingestion_status"


@pytest.mark.asyncio
async def test_diagnostics_and_subgraph_tools_proxy_to_daemon(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    workspace = tmp_path / "repo"
    workspace.mkdir(parents=True, exist_ok=True)
    monkeypatch.chdir(workspace)
    export_dir = str(workspace.resolve())
    daemon = _FakeDaemon()
    app = SimpleNamespace(
        runtime_root=tmp_path / "runtime" / "workspaces",
        session_data_root=tmp_path / "runtime" / "session" / "data",
        daemons={export_dir: daemon},
        job_routes={},
        active_export_dir=export_dir,
    )
    diagnostics = await server.export_diagnostics_md(_ctx(app), export_dir=export_dir, run_id="r1")
    subgraph = await server.graph_subgraph(_ctx(app), node_id="AccountService", export_dir=export_dir)
    assert json.loads(diagnostics)["method"] == "export_diagnostics_md"
    assert json.loads(subgraph)["method"] == "graph_subgraph"


@pytest.mark.asyncio
async def test_analyze_component_proxies_to_current_daemon():
    export_dir = str(Path("/tmp/repo").resolve())
    daemon = _FakeDaemon()
    app = SimpleNamespace(
        runtime_root=Path("/tmp/runtime/workspaces"),
        session_data_root=Path("/tmp/runtime/session/data"),
        daemons={export_dir: daemon},
        job_routes={},
        active_export_dir=export_dir,
    )
    payload = await server.analyze_component("OSS_ServiceabilityTask", _ctx(app), token="accessId", focus="writes")
    decoded = json.loads(payload)
    assert decoded["method"] == "analyze_component"
    assert decoded["params"]["component_name"] == "OSS_ServiceabilityTask"
    assert decoded["params"]["token"] == "accessId"
    assert decoded["params"]["focus"] == "writes"


@pytest.mark.asyncio
async def test_analyze_change_proxies_to_current_daemon():
    export_dir = str(Path("/tmp/repo").resolve())
    daemon = _FakeDaemon()
    app = SimpleNamespace(
        runtime_root=Path("/tmp/runtime/workspaces"),
        session_data_root=Path("/tmp/runtime/session/data"),
        daemons={export_dir: daemon},
        job_routes={},
        active_export_dir=export_dir,
    )
    payload = await server.analyze_change(
        _ctx(app),
        target="AccountService",
        changed_files=["force-app/main/default/classes/AccountService.cls"],
        max_hops=3,
        max_results_per_component=12,
    )
    decoded = json.loads(payload)
    assert decoded["method"] == "analyze_change"
    assert decoded["params"]["target"] == "AccountService"
    assert decoded["params"]["changed_files"] == ["force-app/main/default/classes/AccountService.cls"]
    assert decoded["params"]["max_hops"] == 3
    assert decoded["params"]["max_results_per_component"] == 12


@pytest.mark.asyncio
async def test_analyze_proxies_to_current_daemon():
    export_dir = str(Path("/tmp/repo").resolve())
    daemon = _FakeDaemon()
    app = SimpleNamespace(
        runtime_root=Path("/tmp/runtime/workspaces"),
        session_data_root=Path("/tmp/runtime/session/data"),
        daemons={export_dir: daemon},
        job_routes={},
        active_export_dir=export_dir,
    )
    payload = await server.analyze(
        "where is Service_Id__c populated?",
        _ctx(app),
        mode="exact",
        strict=True,
        max_results=20,
        max_hops=2,
        time_budget_ms=1200,
    )
    decoded = json.loads(payload)
    assert decoded["method"] == "analyze"
    assert decoded["params"]["question"] == "where is Service_Id__c populated?"
    assert decoded["params"]["mode"] == "exact"
    assert decoded["params"]["strict"] is True


@pytest.mark.asyncio
async def test_ask_proxies_to_analyze_with_strict_defaults():
    export_dir = str(Path("/tmp/repo").resolve())
    daemon = _FakeDaemon()
    app = SimpleNamespace(
        runtime_root=Path("/tmp/runtime/workspaces"),
        session_data_root=Path("/tmp/runtime/session/data"),
        daemons={export_dir: daemon},
        job_routes={},
        active_export_dir=export_dir,
    )
    payload = await server.ask(
        "where is Service_Id__c populated?",
        _ctx(app),
    )
    decoded = json.loads(payload)
    assert decoded["method"] == "analyze"
    assert decoded["params"]["question"] == "where is Service_Id__c populated?"
    assert decoded["params"]["mode"] == "auto"
    assert decoded["params"]["strict"] is True


@pytest.mark.asyncio
async def test_query_proxies_allow_vector_fallback_flag():
    export_dir = str(Path("/tmp/repo").resolve())
    daemon = _FakeDaemon()
    app = SimpleNamespace(
        runtime_root=Path("/tmp/runtime/workspaces"),
        session_data_root=Path("/tmp/runtime/session/data"),
        daemons={export_dir: daemon},
        job_routes={},
        active_export_dir=export_dir,
    )
    payload = await server.query(
        "find missing symbol",
        _ctx(app),
        allow_vector_fallback=False,
    )
    decoded = json.loads(payload)
    assert decoded["method"] == "query"
    assert decoded["params"]["allow_vector_fallback"] is False


@pytest.mark.asyncio
async def test_resume_ingest_job_proxies_and_tracks_route():
    export_dir = str(Path("/tmp/repo").resolve())
    daemon = _FakeDaemon()

    def call_with_resume(method: str, **params):
        daemon.calls.append((method, params))
        if method == "resume_ingest_job":
            return {
                "job_id": "job-resumed",
                "job_type": "ingest",
                "export_dir": export_dir,
                "state": "queued",
            }
        if method == "list_ingest_jobs":
            return {"active_job_id": None, "jobs": []}
        return {"method": method, "params": params, "daemon": daemon.name}

    daemon.call = call_with_resume  # type: ignore[method-assign]
    app = SimpleNamespace(
        runtime_root=Path("/tmp/runtime/workspaces"),
        session_data_root=Path("/tmp/runtime/session/data"),
        daemons={export_dir: daemon},
        job_routes={"job-old": export_dir},
        active_export_dir=export_dir,
    )
    payload = await server.resume_ingest_job("job-old", _ctx(app))
    decoded = json.loads(payload)
    assert decoded["job_id"] == "job-resumed"
    assert app.job_routes["job-resumed"] == export_dir


@pytest.mark.asyncio
async def test_status_uses_session_daemon_before_export_activation(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    workspace = tmp_path / "repo"
    workspace.mkdir(parents=True, exist_ok=True)
    monkeypatch.chdir(workspace)
    daemon = _FakeDaemon("session")
    created: list[tuple[Path, Path | None]] = []

    def fake_ensure_daemon_client(data_root: Path, workspace_root: Path | None = None):
        created.append((data_root, workspace_root))
        return daemon

    monkeypatch.setattr(server, "ensure_daemon_client", fake_ensure_daemon_client)
    app = SimpleNamespace(
        runtime_root=tmp_path / "runtime" / "workspaces",
        session_data_root=tmp_path / "runtime" / "session" / "data",
        daemons={},
        job_routes={},
        active_export_dir=None,
    )

    status_payload = json.loads(await server.get_ingestion_status(_ctx(app)))
    progress_payload = json.loads(await server.get_ingestion_progress(_ctx(app)))

    assert status_payload["daemon"] == "session"
    assert progress_payload["daemon"] == "session"
    assert created
    assert created[0][0] == app.session_data_root


@pytest.mark.asyncio
async def test_export_path_guard_still_applies(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    workspace = tmp_path / "repo"
    outside = tmp_path / "outside"
    workspace.mkdir(parents=True, exist_ok=True)
    outside.mkdir(parents=True, exist_ok=True)
    monkeypatch.chdir(workspace)
    app = SimpleNamespace(
        runtime_root=tmp_path / "runtime" / "workspaces",
        session_data_root=tmp_path / "runtime" / "session" / "data",
        daemons={},
        job_routes={},
        active_export_dir=None,
    )
    monkeypatch.setattr(server, "ensure_daemon_client", lambda data_root, workspace_root=None: _FakeDaemon())

    with pytest.raises(ValueError):
        await server.ingest_org(str(outside), _ctx(app), mode="full")


@pytest.mark.asyncio
async def test_start_jobs_use_separate_daemons_per_export_dir(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    workspace = tmp_path / "repo"
    first = workspace / "first"
    second = workspace / "second"
    first.mkdir(parents=True, exist_ok=True)
    second.mkdir(parents=True, exist_ok=True)
    monkeypatch.chdir(workspace)

    created: dict[str, _FakeDaemon] = {}

    def fake_ensure_daemon_client(data_root: Path, workspace_root: Path | None = None):
        daemon = _FakeDaemon(str(workspace_root))
        created[str(workspace_root)] = daemon
        return daemon

    monkeypatch.setattr(server, "ensure_daemon_client", fake_ensure_daemon_client)

    app = SimpleNamespace(
        runtime_root=tmp_path / "runtime" / "workspaces",
        session_data_root=tmp_path / "runtime" / "session" / "data",
        daemons={},
        job_routes={},
        active_export_dir=None,
    )

    payload_a = json.loads(await server.start_ingest_job(str(first), _ctx(app), mode="full"))
    payload_b = json.loads(await server.start_ingest_job(str(second), _ctx(app), mode="full"))

    assert payload_a["daemon"] != payload_b["daemon"]
    assert len(app.daemons) == 2


@pytest.mark.asyncio
async def test_get_ingest_job_routes_to_recorded_workspace(tmp_path: Path):
    first = str((tmp_path / "repo" / "first").resolve())
    daemon = _FakeDaemon("first")

    def fake_call(method: str, **params):
        daemon.calls.append((method, params))
        if method == "get_ingest_job":
            return {"job_id": params["job_id"], "state": "running", "daemon": "first"}
        return {"method": method, "params": params, "daemon": "first"}

    daemon.call = fake_call  # type: ignore[method-assign]
    app = SimpleNamespace(
        runtime_root=tmp_path / "runtime" / "workspaces",
        session_data_root=tmp_path / "runtime" / "session" / "data",
        daemons={first: daemon},
        job_routes={"job-123": first},
        active_export_dir=first,
    )

    payload = json.loads(await server.get_ingest_job("job-123", _ctx(app)))
    assert payload["daemon"] == "first"
