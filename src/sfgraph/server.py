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
    daemon: DaemonClient
    data_root: Path


@asynccontextmanager
async def lifespan(server: FastMCP):
    data_root = Path(os.getenv("SFGRAPH_DATA_DIR", "./data")).expanduser().resolve()
    data_root.mkdir(parents=True, exist_ok=True)
    daemon = ensure_daemon_client(data_root)
    logger.info("Connected to sfgraph daemon at %s", daemon.base_url)
    yield AppContext(daemon=daemon, data_root=data_root)


mcp = FastMCP("sfgraph", lifespan=lifespan)


def _daemon_call(app: AppContext, method: str, **params: Any) -> str:
    return json.dumps(app.daemon.call(method, **params), indent=2)


@mcp.tool()
async def ping(ctx: Context) -> str:
    app: AppContext = ctx.request_context.lifespan_context
    return json.dumps(app.daemon.call("ping"), indent=2)


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
    return _daemon_call(
        app,
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
    return _daemon_call(
        app,
        "start_ingest_job",
        export_dir=export_dir,
        mode=mode,
        include_globs=include_globs or [],
        exclude_globs=exclude_globs or [],
    )


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
    return _daemon_call(
        app,
        "start_refresh_job",
        export_dir=export_dir,
        mode=mode,
        include_globs=include_globs or [],
        exclude_globs=exclude_globs or [],
    )


@mcp.tool()
async def start_vectorize_job(export_dir: str, ctx: Context) -> str:
    app: AppContext = ctx.request_context.lifespan_context
    export_dir = _validate_workspace_export_dir(export_dir)
    return _daemon_call(app, "start_vectorize_job", export_dir=export_dir)


@mcp.tool()
async def get_ingest_job(job_id: str, ctx: Context) -> str:
    app: AppContext = ctx.request_context.lifespan_context
    return _daemon_call(app, "get_ingest_job", job_id=job_id)


@mcp.tool()
async def list_ingest_jobs(ctx: Context) -> str:
    app: AppContext = ctx.request_context.lifespan_context
    return _daemon_call(app, "list_ingest_jobs")


@mcp.tool()
async def cancel_ingest_job(job_id: str, ctx: Context) -> str:
    app: AppContext = ctx.request_context.lifespan_context
    return _daemon_call(app, "cancel_ingest_job", job_id=job_id)


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
    return _daemon_call(
        app,
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
    return _daemon_call(app, "vectorize", export_dir=export_dir)


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
    return _daemon_call(
        app,
        "watch_refresh",
        export_dir=export_dir,
        duration_seconds=duration_seconds,
        poll_interval=poll_interval,
        debounce_seconds=debounce_seconds,
        max_refreshes=max_refreshes,
    )


@mcp.tool()
async def get_ingestion_status(ctx: Context) -> str:
    app: AppContext = ctx.request_context.lifespan_context
    return _daemon_call(app, "get_ingestion_status")


@mcp.tool()
async def get_ingestion_progress(ctx: Context) -> str:
    app: AppContext = ctx.request_context.lifespan_context
    return _daemon_call(app, "get_ingestion_progress")


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
    return _daemon_call(app, "trace_upstream", node_id=node_id, max_hops=max_hops, max_results=max_results, time_budget_ms=time_budget_ms, offset=offset)


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
    return _daemon_call(app, "trace_downstream", node_id=node_id, max_hops=max_hops, max_results=max_results, time_budget_ms=time_budget_ms, offset=offset)


@mcp.tool()
async def get_node(node_id: str, ctx: Context) -> str:
    app: AppContext = ctx.request_context.lifespan_context
    return _daemon_call(app, "get_node", node_id=node_id)


@mcp.tool()
async def explain_field(field_qualified_name: str, ctx: Context) -> str:
    app: AppContext = ctx.request_context.lifespan_context
    return _daemon_call(app, "explain_field", field_qualified_name=field_qualified_name)


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
    return _daemon_call(app, "query", question=question, max_hops=max_hops, max_results=max_results, time_budget_ms=time_budget_ms, offset=offset)


@mcp.tool()
async def impact_from_git_diff(
    ctx: Context,
    base_ref: str = "HEAD~1",
    head_ref: str = "HEAD",
    max_hops: int = 2,
    max_results_per_component: int = 25,
) -> str:
    app: AppContext = ctx.request_context.lifespan_context
    return _daemon_call(app, "impact_from_git_diff", base_ref=base_ref, head_ref=head_ref, max_hops=max_hops, max_results_per_component=max_results_per_component)


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
    return _daemon_call(app, "cross_layer_flow_map", node_id=node_id, max_hops=max_hops, max_results=max_results, time_budget_ms=time_budget_ms, offset=offset)


@mcp.tool()
async def list_unknown_dynamic_edges(
    ctx: Context,
    limit: int = 200,
    offset: int = 0,
) -> str:
    app: AppContext = ctx.request_context.lifespan_context
    return _daemon_call(app, "list_unknown_dynamic_edges", limit=limit, offset=offset)


@mcp.tool()
async def create_snapshot(
    ctx: Context,
    name: str | None = None,
) -> str:
    app: AppContext = ctx.request_context.lifespan_context
    return _daemon_call(app, "create_snapshot", name=name)


@mcp.tool()
async def diff_snapshots(
    snapshot_a_path: str,
    snapshot_b_path: str,
    ctx: Context,
    max_examples: int = 200,
) -> str:
    app: AppContext = ctx.request_context.lifespan_context
    _ = ctx
    return _daemon_call(app, "diff_snapshots", snapshot_a_path=snapshot_a_path, snapshot_b_path=snapshot_b_path, max_examples=max_examples)


@mcp.tool()
async def migrate_project_scope(
    export_dir: str,
    ctx: Context,
    dry_run: bool = True,
    prune_legacy: bool = False,
) -> str:
    app: AppContext = ctx.request_context.lifespan_context
    export_dir = _validate_workspace_export_dir(export_dir)
    return _daemon_call(app, "migrate_project_scope", export_dir=export_dir, dry_run=dry_run, prune_legacy=prune_legacy)


@mcp.tool()
async def test_gap_intelligence_from_git_diff(
    ctx: Context,
    base_ref: str = "HEAD~1",
    head_ref: str = "HEAD",
    max_hops: int = 2,
    max_results_per_component: int = 25,
) -> str:
    app: AppContext = ctx.request_context.lifespan_context
    return _daemon_call(app, "test_gap_intelligence_from_git_diff", base_ref=base_ref, head_ref=head_ref, max_hops=max_hops, max_results_per_component=max_results_per_component)


if __name__ == "__main__":
    mcp.run()
