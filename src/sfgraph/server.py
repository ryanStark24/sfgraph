# src/sfgraph/server.py
# CRITICAL: stderr redirect must be the FIRST executable lines — before any other imports.
import sys
import logging

logging.basicConfig(
    stream=sys.stderr,
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(name)s: %(message)s",
)

from contextlib import asynccontextmanager
from dataclasses import dataclass
import hashlib
import json
import os
from pathlib import Path
from typing import Any

from mcp.server.fastmcp import Context, FastMCP

from sfgraph.daemon_client import DaemonClient, ensure_daemon_client

logger = logging.getLogger(__name__)


def _validate_workspace_export_dir(export_dir: str) -> str:
    workspace_root = Path.cwd().resolve()
    resolved = Path(export_dir).expanduser().resolve()
    if resolved != workspace_root and workspace_root not in resolved.parents:
        raise ValueError(
            f"Export directory must be inside workspace root {workspace_root}, got {resolved}"
        )
    return str(resolved)


@dataclass
class AppContext:
    runtime_root: Path
    session_data_root: Path
    daemons: dict[str, DaemonClient]
    job_routes: dict[str, str]
    active_export_dir: str | None = None


def _resolve_runtime_root(session_data_root: Path) -> Path:
    configured = os.getenv("SFGRAPH_RUNTIME_ROOT")
    if configured:
        return Path(configured).expanduser().resolve()
    if session_data_root.name == "data" and session_data_root.parent.parent.name == "workspaces":
        return session_data_root.parent.parent
    return (session_data_root.parent / "workspaces").resolve()


def _workspace_key(export_dir: str) -> str:
    return hashlib.sha1(export_dir.encode("utf-8")).hexdigest()[:12]


def _data_root_for_export_dir(runtime_root: Path, export_dir: str) -> Path:
    return runtime_root / _workspace_key(export_dir) / "data"


def _session_daemon(app: AppContext) -> DaemonClient:
    session_key = str(Path.cwd().resolve())
    daemon = app.daemons.get(session_key)
    if daemon is None:
        app.session_data_root.mkdir(parents=True, exist_ok=True)
        daemon = ensure_daemon_client(app.session_data_root, workspace_root=Path(session_key))
        app.daemons[session_key] = daemon
    return daemon


def _daemon_for_export_dir(app: AppContext, export_dir: str, *, activate: bool = True) -> DaemonClient:
    resolved = str(Path(export_dir).expanduser().resolve())
    daemon = app.daemons.get(resolved)
    if daemon is None:
        data_root = _data_root_for_export_dir(app.runtime_root, resolved)
        data_root.mkdir(parents=True, exist_ok=True)
        daemon = ensure_daemon_client(data_root, workspace_root=Path(resolved))
        app.daemons[resolved] = daemon
    if activate:
        app.active_export_dir = resolved
    return daemon


def _current_daemon(app: AppContext, export_dir: str | None = None) -> DaemonClient:
    if export_dir:
        return _daemon_for_export_dir(app, _validate_workspace_export_dir(export_dir))
    if app.active_export_dir:
        return _daemon_for_export_dir(app, app.active_export_dir)
    if len(app.daemons) == 1:
        only_export_dir = next(iter(app.daemons))
        return _daemon_for_export_dir(app, only_export_dir, activate=False)
    return _session_daemon(app)


def _all_known_export_dirs(app: AppContext) -> list[str]:
    export_dirs = set(app.daemons.keys())
    if app.runtime_root.exists():
        for candidate in app.runtime_root.iterdir():
            meta_path = candidate / "data" / "daemon.json"
            if not meta_path.exists():
                continue
            try:
                payload = json.loads(meta_path.read_text(encoding="utf-8"))
            except Exception:
                continue
            workspace_root = str(payload.get("workspace_root") or "").strip()
            if workspace_root:
                export_dirs.add(str(Path(workspace_root).expanduser().resolve()))
    return sorted(export_dirs)


def _find_daemon_for_job(app: AppContext, job_id: str) -> DaemonClient:
    routed = app.job_routes.get(job_id)
    if routed:
        return _daemon_for_export_dir(app, routed, activate=False)
    for export_dir in _all_known_export_dirs(app):
        daemon = _daemon_for_export_dir(app, export_dir, activate=False)
        payload = daemon.call("list_ingest_jobs")
        for job in payload.get("jobs", []):
            if str(job.get("job_id")) == job_id:
                app.job_routes[job_id] = export_dir
                return daemon
    raise RuntimeError(f"Job {job_id} was not found in any known workspace.")


@asynccontextmanager
async def lifespan(server: FastMCP):
    data_root = Path(os.getenv("SFGRAPH_DATA_DIR", "./data")).expanduser().resolve()
    data_root.mkdir(parents=True, exist_ok=True)
    runtime_root = _resolve_runtime_root(data_root)
    runtime_root.mkdir(parents=True, exist_ok=True)
    yield AppContext(
        runtime_root=runtime_root,
        session_data_root=data_root,
        daemons={},
        job_routes={},
    )


mcp = FastMCP("sfgraph", lifespan=lifespan)


def _daemon_call(daemon: DaemonClient, method: str, **params: Any) -> str:
    return json.dumps(daemon.call(method, **params), indent=2)


@mcp.tool()
async def ping(ctx: Context) -> str:
    app: AppContext = ctx.request_context.lifespan_context
    return json.dumps(
        {
            "ok": True,
            "runtime_root": str(app.runtime_root),
            "known_workspaces": _all_known_export_dirs(app),
            "active_export_dir": app.active_export_dir,
        },
        indent=2,
    )


@mcp.tool()
async def ingest_org(
    export_dir: str,
    ctx: Context,
    mode: str = "full",
    include_globs: list[str] | None = None,
    exclude_globs: list[str] | None = None,
) -> str:
    app: AppContext = ctx.request_context.lifespan_context
    export_dir = _validate_workspace_export_dir(export_dir)
    daemon = _daemon_for_export_dir(app, export_dir)
    return _daemon_call(
        daemon,
        "ingest_org",
        export_dir=export_dir,
        mode=mode,
        include_globs=include_globs or [],
        exclude_globs=exclude_globs or [],
    )


@mcp.tool()
async def start_ingest_job(
    export_dir: str,
    ctx: Context,
    mode: str = "full",
    include_globs: list[str] | None = None,
    exclude_globs: list[str] | None = None,
) -> str:
    app: AppContext = ctx.request_context.lifespan_context
    export_dir = _validate_workspace_export_dir(export_dir)
    daemon = _daemon_for_export_dir(app, export_dir)
    result = daemon.call(
        "start_ingest_job",
        export_dir=export_dir,
        mode=mode,
        include_globs=include_globs or [],
        exclude_globs=exclude_globs or [],
    )
    job_id = str(result.get("job_id") or "")
    if job_id:
        app.job_routes[job_id] = export_dir
    return json.dumps(result, indent=2)


@mcp.tool()
async def start_refresh_job(
    export_dir: str,
    ctx: Context,
    mode: str = "full",
    include_globs: list[str] | None = None,
    exclude_globs: list[str] | None = None,
) -> str:
    app: AppContext = ctx.request_context.lifespan_context
    export_dir = _validate_workspace_export_dir(export_dir)
    daemon = _daemon_for_export_dir(app, export_dir)
    result = daemon.call(
        "start_refresh_job",
        export_dir=export_dir,
        mode=mode,
        include_globs=include_globs or [],
        exclude_globs=exclude_globs or [],
    )
    job_id = str(result.get("job_id") or "")
    if job_id:
        app.job_routes[job_id] = export_dir
    return json.dumps(result, indent=2)


@mcp.tool()
async def start_vectorize_job(export_dir: str, ctx: Context) -> str:
    app: AppContext = ctx.request_context.lifespan_context
    export_dir = _validate_workspace_export_dir(export_dir)
    daemon = _daemon_for_export_dir(app, export_dir)
    result = daemon.call("start_vectorize_job", export_dir=export_dir)
    job_id = str(result.get("job_id") or "")
    if job_id:
        app.job_routes[job_id] = export_dir
    return json.dumps(result, indent=2)


@mcp.tool()
async def get_ingest_job(job_id: str, ctx: Context) -> str:
    app: AppContext = ctx.request_context.lifespan_context
    daemon = _find_daemon_for_job(app, job_id)
    return _daemon_call(daemon, "get_ingest_job", job_id=job_id)


@mcp.tool()
async def list_ingest_jobs(ctx: Context) -> str:
    app: AppContext = ctx.request_context.lifespan_context
    jobs: list[dict[str, Any]] = []
    active_by_workspace: dict[str, str | None] = {}
    for export_dir in _all_known_export_dirs(app):
        daemon = _daemon_for_export_dir(app, export_dir, activate=False)
        payload = daemon.call("list_ingest_jobs")
        active_by_workspace[export_dir] = payload.get("active_job_id")
        for job in payload.get("jobs", []):
            job_payload = dict(job)
            job_payload["workspace_export_dir"] = export_dir
            jobs.append(job_payload)
            job_id = str(job_payload.get("job_id") or "")
            if job_id:
                app.job_routes[job_id] = export_dir
    jobs.sort(key=lambda item: str(item.get("created_at") or ""), reverse=True)
    return json.dumps(
        {
            "active_export_dir": app.active_export_dir,
            "workspaces": active_by_workspace,
            "jobs": jobs,
        },
        indent=2,
    )


@mcp.tool()
async def cancel_ingest_job(job_id: str, ctx: Context) -> str:
    app: AppContext = ctx.request_context.lifespan_context
    daemon = _find_daemon_for_job(app, job_id)
    return _daemon_call(daemon, "cancel_ingest_job", job_id=job_id)


@mcp.tool()
async def refresh(
    export_dir: str,
    ctx: Context,
    mode: str = "full",
    include_globs: list[str] | None = None,
    exclude_globs: list[str] | None = None,
) -> str:
    app: AppContext = ctx.request_context.lifespan_context
    export_dir = _validate_workspace_export_dir(export_dir)
    daemon = _daemon_for_export_dir(app, export_dir)
    return _daemon_call(
        daemon,
        "refresh",
        export_dir=export_dir,
        mode=mode,
        include_globs=include_globs or [],
        exclude_globs=exclude_globs or [],
    )


@mcp.tool()
async def vectorize(export_dir: str, ctx: Context) -> str:
    app: AppContext = ctx.request_context.lifespan_context
    export_dir = _validate_workspace_export_dir(export_dir)
    daemon = _daemon_for_export_dir(app, export_dir)
    return _daemon_call(daemon, "vectorize", export_dir=export_dir)


@mcp.tool()
async def watch_refresh(
    export_dir: str,
    ctx: Context,
    duration_seconds: int = 60,
    poll_interval: float = 1.0,
    debounce_seconds: float = 2.0,
    max_refreshes: int = 25,
) -> str:
    app: AppContext = ctx.request_context.lifespan_context
    export_dir = _validate_workspace_export_dir(export_dir)
    daemon = _daemon_for_export_dir(app, export_dir)
    return _daemon_call(
        daemon,
        "watch_refresh",
        export_dir=export_dir,
        duration_seconds=duration_seconds,
        poll_interval=poll_interval,
        debounce_seconds=debounce_seconds,
        max_refreshes=max_refreshes,
    )


@mcp.tool()
async def get_ingestion_status(ctx: Context, export_dir: str | None = None) -> str:
    app: AppContext = ctx.request_context.lifespan_context
    daemon = _current_daemon(app, export_dir)
    return _daemon_call(daemon, "get_ingestion_status")


@mcp.tool()
async def get_ingestion_progress(ctx: Context, export_dir: str | None = None) -> str:
    app: AppContext = ctx.request_context.lifespan_context
    daemon = _current_daemon(app, export_dir)
    return _daemon_call(daemon, "get_ingestion_progress")


@mcp.tool()
async def trace_upstream(
    node_id: str,
    ctx: Context,
    max_hops: int = 3,
    max_results: int = 50,
    time_budget_ms: int = 1500,
    offset: int = 0,
) -> str:
    app: AppContext = ctx.request_context.lifespan_context
    daemon = _current_daemon(app)
    return _daemon_call(daemon, "trace_upstream", node_id=node_id, max_hops=max_hops, max_results=max_results, time_budget_ms=time_budget_ms, offset=offset)


@mcp.tool()
async def trace_downstream(
    node_id: str,
    ctx: Context,
    max_hops: int = 3,
    max_results: int = 50,
    time_budget_ms: int = 1500,
    offset: int = 0,
) -> str:
    app: AppContext = ctx.request_context.lifespan_context
    daemon = _current_daemon(app)
    return _daemon_call(daemon, "trace_downstream", node_id=node_id, max_hops=max_hops, max_results=max_results, time_budget_ms=time_budget_ms, offset=offset)


@mcp.tool()
async def get_node(node_id: str, ctx: Context) -> str:
    app: AppContext = ctx.request_context.lifespan_context
    daemon = _current_daemon(app)
    return _daemon_call(daemon, "get_node", node_id=node_id)


@mcp.tool()
async def explain_field(field_qualified_name: str, ctx: Context) -> str:
    app: AppContext = ctx.request_context.lifespan_context
    daemon = _current_daemon(app)
    return _daemon_call(daemon, "explain_field", field_qualified_name=field_qualified_name)


@mcp.tool()
async def query(
    question: str,
    ctx: Context,
    max_hops: int = 3,
    max_results: int = 50,
    time_budget_ms: int = 1500,
    offset: int = 0,
) -> str:
    app: AppContext = ctx.request_context.lifespan_context
    daemon = _current_daemon(app)
    return _daemon_call(daemon, "query", question=question, max_hops=max_hops, max_results=max_results, time_budget_ms=time_budget_ms, offset=offset)


@mcp.tool()
async def impact_from_git_diff(
    ctx: Context,
    base_ref: str = "HEAD~1",
    head_ref: str = "HEAD",
    max_hops: int = 2,
    max_results_per_component: int = 25,
) -> str:
    app: AppContext = ctx.request_context.lifespan_context
    daemon = _current_daemon(app)
    return _daemon_call(daemon, "impact_from_git_diff", base_ref=base_ref, head_ref=head_ref, max_hops=max_hops, max_results_per_component=max_results_per_component)


@mcp.tool()
async def cross_layer_flow_map(
    node_id: str,
    ctx: Context,
    max_hops: int = 5,
    max_results: int = 50,
    time_budget_ms: int = 2500,
    offset: int = 0,
) -> str:
    app: AppContext = ctx.request_context.lifespan_context
    daemon = _current_daemon(app)
    return _daemon_call(daemon, "cross_layer_flow_map", node_id=node_id, max_hops=max_hops, max_results=max_results, time_budget_ms=time_budget_ms, offset=offset)


@mcp.tool()
async def list_unknown_dynamic_edges(
    ctx: Context,
    limit: int = 200,
    offset: int = 0,
) -> str:
    app: AppContext = ctx.request_context.lifespan_context
    daemon = _current_daemon(app)
    return _daemon_call(daemon, "list_unknown_dynamic_edges", limit=limit, offset=offset)


@mcp.tool()
async def create_snapshot(
    ctx: Context,
    name: str | None = None,
) -> str:
    app: AppContext = ctx.request_context.lifespan_context
    daemon = _current_daemon(app)
    return _daemon_call(daemon, "create_snapshot", name=name)


@mcp.tool()
async def diff_snapshots(
    snapshot_a_path: str,
    snapshot_b_path: str,
    ctx: Context,
    max_examples: int = 200,
) -> str:
    app: AppContext = ctx.request_context.lifespan_context
    _ = ctx
    daemon = _current_daemon(app)
    return _daemon_call(daemon, "diff_snapshots", snapshot_a_path=snapshot_a_path, snapshot_b_path=snapshot_b_path, max_examples=max_examples)


@mcp.tool()
async def migrate_project_scope(
    export_dir: str,
    ctx: Context,
    dry_run: bool = True,
    prune_legacy: bool = False,
) -> str:
    app: AppContext = ctx.request_context.lifespan_context
    export_dir = _validate_workspace_export_dir(export_dir)
    daemon = _daemon_for_export_dir(app, export_dir)
    return _daemon_call(daemon, "migrate_project_scope", export_dir=export_dir, dry_run=dry_run, prune_legacy=prune_legacy)


@mcp.tool()
async def test_gap_intelligence_from_git_diff(
    ctx: Context,
    base_ref: str = "HEAD~1",
    head_ref: str = "HEAD",
    max_hops: int = 2,
    max_results_per_component: int = 25,
) -> str:
    app: AppContext = ctx.request_context.lifespan_context
    daemon = _current_daemon(app)
    return _daemon_call(daemon, "test_gap_intelligence_from_git_diff", base_ref=base_ref, head_ref=head_ref, max_hops=max_hops, max_results_per_component=max_results_per_component)


if __name__ == "__main__":
    mcp.run()
