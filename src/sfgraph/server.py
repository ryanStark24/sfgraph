# src/sfgraph/server.py
# CRITICAL: stderr redirect must be the FIRST executable lines — before any other imports.
import sys
import logging

logging.basicConfig(
    stream=sys.stderr,
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(name)s: %(message)s",
)

# Only import AFTER logging is configured.
from contextlib import asynccontextmanager
from dataclasses import dataclass
import json
import os
from pathlib import Path
from typing import Any

from mcp.server.fastmcp import FastMCP, Context

from sfgraph.ingestion.job_manager import IngestJobManager
from sfgraph.ingestion.scope_migration import ScopeMigrationService
from sfgraph.ingestion.snapshot import GraphSnapshotService
from sfgraph.ingestion.service import IngestionService
from sfgraph.query.graph_query_service import GraphQueryService
from sfgraph.storage.duckpgq_store import DuckPGQStore
from sfgraph.storage.vector_store import VectorStore
from sfgraph.storage.manifest_store import ManifestStore
from sfgraph.parser.pool import NodeParserPool

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
    graph: DuckPGQStore
    vectors: VectorStore
    manifest: ManifestStore
    pool: NodeParserPool
    data_root: Path
    jobs: IngestJobManager


@asynccontextmanager
async def lifespan(server: FastMCP):
    """Initialize all storage handles and parser pool. MCP-01."""
    data_root = Path(os.getenv("SFGRAPH_DATA_DIR", "./data")).expanduser().resolve()
    data_root.mkdir(parents=True, exist_ok=True)
    graph = DuckPGQStore(db_path=str(data_root / "sfgraph.duckdb"))
    vectors = VectorStore(path=str(data_root / "vectors"))
    manifest = ManifestStore(db_path=str(data_root / "manifest.sqlite"))
    pool = NodeParserPool()
    jobs = IngestJobManager(
        ingest_factory=lambda export_dir, options: _build_ingestion_service_from_parts(
            graph=graph,
            manifest=manifest,
            pool=pool,
            vectors=vectors,
            data_root=data_root,
            mode=str(options.get("mode", "full")),
            include_globs=_as_string_list(options.get("include_globs")),
            exclude_globs=_as_string_list(options.get("exclude_globs")),
        ).ingest(export_dir),
        refresh_factory=lambda export_dir, options: _build_ingestion_service_from_parts(
            graph=graph,
            manifest=manifest,
            pool=pool,
            vectors=vectors,
            data_root=data_root,
            mode=str(options.get("mode", "full")),
            include_globs=_as_string_list(options.get("include_globs")),
            exclude_globs=_as_string_list(options.get("exclude_globs")),
        ).refresh(export_dir),
        vectorize_factory=lambda export_dir, options: _build_ingestion_service_from_parts(
            graph=graph,
            manifest=manifest,
            pool=pool,
            vectors=vectors,
            data_root=data_root,
            mode="full",
            include_globs=[],
            exclude_globs=[],
        ).vectorize(export_dir),
    )

    await manifest.initialize()
    await vectors.initialize()
    await pool.start()
    logger.info("All storage engines initialized")

    yield AppContext(graph=graph, vectors=vectors, manifest=manifest, pool=pool, data_root=data_root, jobs=jobs)

    await pool.shutdown()
    await manifest.close()
    await graph.close()
    logger.info("All storage engines closed")


mcp = FastMCP("sfgraph", lifespan=lifespan)


def _build_ingestion_service(app: AppContext) -> IngestionService:
    return _build_ingestion_service_from_parts(
        graph=app.graph,
        manifest=app.manifest,
        pool=app.pool,
        vectors=app.vectors,
        data_root=app.data_root,
    )


def _build_ingestion_service_from_parts(
    *,
    graph: DuckPGQStore,
    manifest: ManifestStore,
    pool: NodeParserPool,
    vectors: VectorStore,
    data_root: Path,
    mode: str = "full",
    include_globs: list[str] | None = None,
    exclude_globs: list[str] | None = None,
) -> IngestionService:
    vector_store = vectors if mode != "graph_only" else None
    return IngestionService(
        graph=graph,
        manifest=manifest,
        pool=pool,
        vectors=vector_store,
        ingestion_meta_path=str(data_root / "ingestion_meta.json"),
        ingestion_progress_path=str(data_root / "ingestion_progress.json"),
        include_globs=include_globs,
        exclude_globs=exclude_globs,
    )


def _build_query_service(app: AppContext) -> GraphQueryService:
    return GraphQueryService(
        graph=app.graph,
        manifest=app.manifest,
        vectors=app.vectors,
        repo_root=str(Path.cwd()),
        ingestion_meta_path=str(app.data_root / "ingestion_meta.json"),
        ingestion_progress_path=str(app.data_root / "ingestion_progress.json"),
    )


def _merge_job_with_progress(job: dict[str, Any], progress: dict[str, Any]) -> dict[str, Any]:
    payload = dict(job)
    if progress.get("available"):
        payload["progress"] = progress
    return payload


def _as_string_list(value: Any) -> list[str]:
    if value is None:
        return []
    if isinstance(value, list):
        return [str(item) for item in value if str(item)]
    return [str(value)] if str(value) else []


def _read_progress_snapshot(data_root: Path) -> dict[str, Any]:
    progress_path = data_root / "ingestion_progress.json"
    if not progress_path.exists():
        return {"available": False, "state": "idle"}
    try:
        payload = json.loads(progress_path.read_text(encoding="utf-8"))
    except Exception:
        return {"available": False, "state": "idle"}
    if not isinstance(payload, dict):
        return {"available": False, "state": "idle"}
    payload = dict(payload)
    payload["available"] = True
    return payload


def _deprecated_tool_payload(*, tool_name: str, replacement: str) -> dict[str, Any]:
    return {
        "deprecated": True,
        "tool": tool_name,
        "replacement_tool": replacement,
        "message": (
            f"{tool_name} is deprecated and will be removed in a future release. "
            f"Use {replacement} for background execution and progress polling."
        ),
    }


async def _assert_no_active_background_job(app: AppContext, tool_name: str) -> None:
    active_job = await app.jobs.get_active_job()
    if active_job is None:
        return
    raise RuntimeError(
        f"{tool_name} cannot run while background job {active_job['job_id']} "
        f"({active_job['job_type']}) is {active_job['state']}. "
        "Wait for it to complete or cancel it first."
    )


@mcp.tool()
async def ping(ctx: Context) -> str:
    """Health check tool — confirms lifespan context is wired correctly."""
    app: AppContext = ctx.request_context.lifespan_context
    pool_size = len(app.pool._workers)
    return f"ok — pool_size={pool_size}"


@mcp.tool()
async def ingest_org(
    export_dir: str,
    ctx: Context,
    mode: str = "full",
    include_globs: list[str] | None = None,
    exclude_globs: list[str] | None = None,
) -> str:
    """Deprecated: use start_ingest_job for non-blocking ingest with polling. Default discovery scans workspace-root force-app/ and vlocity/ when present."""
    app: AppContext = ctx.request_context.lifespan_context
    await _assert_no_active_background_job(app, "ingest_org")
    export_dir = _validate_workspace_export_dir(export_dir)
    logger.warning(
        "Deprecated MCP tool ingest_org called for %s. Use start_ingest_job instead.",
        export_dir,
    )
    service = _build_ingestion_service_from_parts(
        graph=app.graph,
        manifest=app.manifest,
        pool=app.pool,
        vectors=app.vectors,
        data_root=app.data_root,
        mode=mode,
        include_globs=include_globs,
        exclude_globs=exclude_globs,
    )
    summary = await service.ingest(export_dir)
    return json.dumps(
        {
            **_deprecated_tool_payload(tool_name="ingest_org", replacement="start_ingest_job"),
            "run_id": summary.run_id,
            "export_dir": summary.export_dir,
            "duration_seconds": summary.duration_seconds,
            "total_nodes": summary.total_nodes,
            "node_counts_by_type": summary.node_counts_by_type,
            "edge_count": summary.edge_count,
            "parse_failures": summary.parse_failures,
            "orphaned_edges": summary.orphaned_edges,
            "parser_stats": summary.parser_stats,
            "unresolved_symbols": summary.unresolved_symbols,
            "warnings": summary.warnings[:20],
            "mode": mode,
            "include_globs": include_globs or [],
            "exclude_globs": exclude_globs or [],
        },
        indent=2,
    )


@mcp.tool()
async def start_ingest_job(
    export_dir: str,
    ctx: Context,
    mode: str = "full",
    include_globs: list[str] | None = None,
    exclude_globs: list[str] | None = None,
) -> str:
    """Start a background full ingest and return a pollable job record. By default discovery scans workspace-root force-app/ and vlocity/ unless include_globs override it."""
    app: AppContext = ctx.request_context.lifespan_context
    export_dir = _validate_workspace_export_dir(export_dir)
    payload = await app.jobs.start_job(
        job_type="ingest",
        export_dir=export_dir,
        options={
            "mode": mode,
            "include_globs": include_globs or [],
            "exclude_globs": exclude_globs or [],
        },
    )
    return json.dumps(payload, indent=2)


@mcp.tool()
async def start_refresh_job(
    export_dir: str,
    ctx: Context,
    mode: str = "full",
    include_globs: list[str] | None = None,
    exclude_globs: list[str] | None = None,
) -> str:
    """Start a background refresh and return a pollable job record. By default discovery scans workspace-root force-app/ and vlocity/ unless include_globs override it."""
    app: AppContext = ctx.request_context.lifespan_context
    export_dir = _validate_workspace_export_dir(export_dir)
    payload = await app.jobs.start_job(
        job_type="refresh",
        export_dir=export_dir,
        options={
            "mode": mode,
            "include_globs": include_globs or [],
            "exclude_globs": exclude_globs or [],
        },
    )
    return json.dumps(payload, indent=2)


@mcp.tool()
async def start_vectorize_job(export_dir: str, ctx: Context) -> str:
    """Start a background vector-only rebuild for the active project scope."""
    app: AppContext = ctx.request_context.lifespan_context
    export_dir = _validate_workspace_export_dir(export_dir)
    payload = await app.jobs.start_job(
        job_type="vectorize",
        export_dir=export_dir,
        options={"mode": "full"},
    )
    return json.dumps(payload, indent=2)


@mcp.tool()
async def get_ingest_job(job_id: str, ctx: Context) -> str:
    """Return job state for a background ingest or refresh."""
    app: AppContext = ctx.request_context.lifespan_context
    job = await app.jobs.get_job(job_id)
    if job is None:
        return json.dumps({"job_id": job_id, "available": False, "error": "job_not_found"}, indent=2)
    progress = _read_progress_snapshot(app.data_root)
    if app.jobs.active_job_id == job_id and progress.get("state") == "running":
        job = _merge_job_with_progress(job, progress)
    job["available"] = True
    return json.dumps(job, indent=2)


@mcp.tool()
async def list_ingest_jobs(ctx: Context) -> str:
    """List recent background ingest jobs for this workspace process."""
    app: AppContext = ctx.request_context.lifespan_context
    jobs = await app.jobs.list_jobs()
    active_job_id = app.jobs.active_job_id
    return json.dumps({"active_job_id": active_job_id, "jobs": jobs}, indent=2)


@mcp.tool()
async def cancel_ingest_job(job_id: str, ctx: Context) -> str:
    """Best-effort cancellation for a background ingest or refresh."""
    app: AppContext = ctx.request_context.lifespan_context
    try:
        payload = await app.jobs.cancel_job(job_id)
    except KeyError:
        payload = {"job_id": job_id, "available": False, "error": "job_not_found"}
    return json.dumps(payload, indent=2)


@mcp.tool()
async def refresh(
    export_dir: str,
    ctx: Context,
    mode: str = "full",
    include_globs: list[str] | None = None,
    exclude_globs: list[str] | None = None,
) -> str:
    """Deprecated: use start_refresh_job for non-blocking refresh with polling. Default discovery scans workspace-root force-app/ and vlocity/ when present."""
    app: AppContext = ctx.request_context.lifespan_context
    await _assert_no_active_background_job(app, "refresh")
    export_dir = _validate_workspace_export_dir(export_dir)
    logger.warning(
        "Deprecated MCP tool refresh called for %s. Use start_refresh_job instead.",
        export_dir,
    )
    service = _build_ingestion_service_from_parts(
        graph=app.graph,
        manifest=app.manifest,
        pool=app.pool,
        vectors=app.vectors,
        data_root=app.data_root,
        mode=mode,
        include_globs=include_globs,
        exclude_globs=exclude_globs,
    )
    summary = await service.refresh(export_dir)
    return json.dumps(
        {
            **_deprecated_tool_payload(tool_name="refresh", replacement="start_refresh_job"),
            "run_id": summary.run_id,
            "export_dir": summary.export_dir,
            "duration_seconds": summary.duration_seconds,
            "processed_files": summary.processed_files,
            "changed_files": summary.changed_files,
            "deleted_files": summary.deleted_files,
            "affected_neighbor_files": summary.affected_neighbor_files,
            "node_count": summary.node_count,
            "edge_count": summary.edge_count,
            "orphaned_edges": summary.orphaned_edges,
            "parser_stats": summary.parser_stats,
            "unresolved_symbols": summary.unresolved_symbols,
            "warnings": summary.warnings[:20],
            "mode": mode,
            "include_globs": include_globs or [],
            "exclude_globs": exclude_globs or [],
        },
        indent=2,
    )


@mcp.tool()
async def vectorize(export_dir: str, ctx: Context) -> str:
    """Rebuild vectors for the current project scope without reparsing source files."""
    app: AppContext = ctx.request_context.lifespan_context
    await _assert_no_active_background_job(app, "vectorize")
    export_dir = _validate_workspace_export_dir(export_dir)
    service = _build_ingestion_service_from_parts(
        graph=app.graph,
        manifest=app.manifest,
        pool=app.pool,
        vectors=app.vectors,
        data_root=app.data_root,
        mode="full",
    )
    summary = await service.vectorize(export_dir)
    return json.dumps(summary.model_dump(), indent=2)


@mcp.tool()
async def watch_refresh(
    export_dir: str,
    ctx: Context,
    duration_seconds: int = 60,
    poll_interval: float = 1.0,
    debounce_seconds: float = 2.0,
    max_refreshes: int = 25,
) -> str:
    """Watch for filesystem changes and trigger debounced incremental refresh."""
    app: AppContext = ctx.request_context.lifespan_context
    await _assert_no_active_background_job(app, "watch_refresh")
    export_dir = _validate_workspace_export_dir(export_dir)
    service = _build_ingestion_service(app)
    payload = await service.watch_refresh(
        export_dir=export_dir,
        duration_seconds=duration_seconds,
        poll_interval=poll_interval,
        debounce_seconds=debounce_seconds,
        max_refreshes=max_refreshes,
    )
    return json.dumps(payload, indent=2)


@mcp.tool()
async def get_ingestion_status(ctx: Context) -> str:
    """Return graph/manifest ingestion status with freshness metadata."""
    app: AppContext = ctx.request_context.lifespan_context
    service = _build_query_service(app)
    status = await service.get_ingestion_status()
    active_job = await app.jobs.get_active_job()
    if active_job is not None:
        progress = _read_progress_snapshot(app.data_root)
        status["active_job"] = _merge_job_with_progress(active_job, progress)
    else:
        status["active_job"] = None
    return json.dumps(status, indent=2)


@mcp.tool()
async def get_ingestion_progress(ctx: Context) -> str:
    """Return live ingestion progress if a full ingest or refresh is running."""
    app: AppContext = ctx.request_context.lifespan_context
    service = _build_query_service(app)
    payload = await service.get_ingestion_progress()
    active_job = await app.jobs.get_active_job()
    if active_job is not None:
        payload["active_job"] = active_job
    return json.dumps(payload, indent=2)


@mcp.tool()
async def trace_upstream(
    node_id: str,
    ctx: Context,
    max_hops: int = 3,
    max_results: int = 50,
    time_budget_ms: int = 1500,
    offset: int = 0,
) -> str:
    """Trace incoming lineage paths to a node with guardrails and evidence."""
    app: AppContext = ctx.request_context.lifespan_context
    service = _build_query_service(app)
    result = await service.trace_upstream(
        start_node=node_id,
        max_hops=max_hops,
        max_results=max_results,
        time_budget_ms=time_budget_ms,
        offset=offset,
    )
    return json.dumps(result, indent=2)


@mcp.tool()
async def trace_downstream(
    node_id: str,
    ctx: Context,
    max_hops: int = 3,
    max_results: int = 50,
    time_budget_ms: int = 1500,
    offset: int = 0,
) -> str:
    """Trace outgoing blast-radius paths from a node with guardrails and evidence."""
    app: AppContext = ctx.request_context.lifespan_context
    service = _build_query_service(app)
    result = await service.trace_downstream(
        start_node=node_id,
        max_hops=max_hops,
        max_results=max_results,
        time_budget_ms=time_budget_ms,
        offset=offset,
    )
    return json.dumps(result, indent=2)


@mcp.tool()
async def get_node(node_id: str, ctx: Context) -> str:
    """Return node details and adjacent edges with evidence/freshness metadata."""
    app: AppContext = ctx.request_context.lifespan_context
    service = _build_query_service(app)
    result = await service.get_node(node_id=node_id)
    return json.dumps(result, indent=2)


@mcp.tool()
async def explain_field(field_qualified_name: str, ctx: Context) -> str:
    """Return an evidence-backed reader/writer/dependent field impact summary."""
    app: AppContext = ctx.request_context.lifespan_context
    service = _build_query_service(app)
    result = await service.explain_field(field_qualified_name=field_qualified_name)
    return json.dumps(result, indent=2)


@mcp.tool()
async def query(
    question: str,
    ctx: Context,
    max_hops: int = 3,
    max_results: int = 50,
    time_budget_ms: int = 1500,
    offset: int = 0,
) -> str:
    """Natural-language-ish query tool with evidence-first structured output."""
    app: AppContext = ctx.request_context.lifespan_context
    service = _build_query_service(app)
    result = await service.query(
        question=question,
        max_hops=max_hops,
        max_results=max_results,
        time_budget_ms=time_budget_ms,
        offset=offset,
    )
    return json.dumps(result, indent=2)


@mcp.tool()
async def impact_from_git_diff(
    ctx: Context,
    base_ref: str = "HEAD~1",
    head_ref: str = "HEAD",
    max_hops: int = 2,
    max_results_per_component: int = 25,
) -> str:
    """Generate change-aware impact report from git diff file list."""
    app: AppContext = ctx.request_context.lifespan_context
    service = _build_query_service(app)
    result = await service.impact_from_git_diff(
        base_ref=base_ref,
        head_ref=head_ref,
        max_hops=max_hops,
        max_results_per_component=max_results_per_component,
    )
    return json.dumps(result, indent=2)


@mcp.tool()
async def cross_layer_flow_map(
    node_id: str,
    ctx: Context,
    max_hops: int = 5,
    max_results: int = 50,
    time_budget_ms: int = 2500,
    offset: int = 0,
) -> str:
    """Show cross-layer lineage map UI -> Flow/OmniScript -> DR/IP -> Apex -> Object/Field."""
    app: AppContext = ctx.request_context.lifespan_context
    service = _build_query_service(app)
    result = await service.cross_layer_flow_map(
        start_node=node_id,
        max_hops=max_hops,
        max_results=max_results,
        time_budget_ms=time_budget_ms,
        offset=offset,
    )
    return json.dumps(result, indent=2)


@mcp.tool()
async def list_unknown_dynamic_edges(
    ctx: Context,
    limit: int = 200,
    offset: int = 0,
) -> str:
    """List unresolved dynamic references for explicit confidence handling."""
    app: AppContext = ctx.request_context.lifespan_context
    service = _build_query_service(app)
    result = await service.list_unknown_dynamic_edges(limit=limit, offset=offset)
    return json.dumps(result, indent=2)


@mcp.tool()
async def create_snapshot(
    ctx: Context,
    name: str | None = None,
) -> str:
    """Create a JSON snapshot of current graph nodes/edges."""
    app: AppContext = ctx.request_context.lifespan_context
    snapshot_service = GraphSnapshotService(graph=app.graph)
    result = await snapshot_service.create_snapshot(name=name)
    return json.dumps(result, indent=2)


@mcp.tool()
async def diff_snapshots(
    snapshot_a_path: str,
    snapshot_b_path: str,
    ctx: Context,
    max_examples: int = 200,
) -> str:
    """Diff two saved graph snapshots and return changed node/edge counts."""
    _ = ctx
    result = GraphSnapshotService.diff_snapshots(
        snapshot_a_path=snapshot_a_path,
        snapshot_b_path=snapshot_b_path,
        max_examples=max_examples,
    )
    return json.dumps(result, indent=2)


@mcp.tool()
async def migrate_project_scope(
    export_dir: str,
    ctx: Context,
    dry_run: bool = True,
    prune_legacy: bool = False,
) -> str:
    """Migrate legacy unscoped graph rows under export_dir to project-scoped keys."""
    app: AppContext = ctx.request_context.lifespan_context
    export_dir = _validate_workspace_export_dir(export_dir)
    service = ScopeMigrationService(graph=app.graph, vectors=app.vectors)
    result = await service.migrate_project_scope(
        export_dir=export_dir,
        dry_run=dry_run,
        prune_legacy=prune_legacy,
    )
    return json.dumps(result, indent=2)


@mcp.tool()
async def test_gap_intelligence_from_git_diff(
    ctx: Context,
    base_ref: str = "HEAD~1",
    head_ref: str = "HEAD",
    max_hops: int = 2,
    max_results_per_component: int = 25,
) -> str:
    """Return coverage-style test gap intelligence for git diff impacted components."""
    app: AppContext = ctx.request_context.lifespan_context
    service = _build_query_service(app)
    result = await service.test_gap_intelligence_from_git_diff(
        base_ref=base_ref,
        head_ref=head_ref,
        max_hops=max_hops,
        max_results_per_component=max_results_per_component,
    )
    return json.dumps(result, indent=2)


if __name__ == "__main__":
    mcp.run()
