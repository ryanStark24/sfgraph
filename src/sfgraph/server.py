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
from pathlib import Path

from mcp.server.fastmcp import FastMCP, Context

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


@asynccontextmanager
async def lifespan(server: FastMCP):
    """Initialize all storage handles and parser pool. MCP-01."""
    Path("./data").mkdir(parents=True, exist_ok=True)
    graph = DuckPGQStore(db_path="./data/sfgraph.duckdb")
    vectors = VectorStore(path="./data/vectors")
    manifest = ManifestStore(db_path="./data/manifest.sqlite")
    pool = NodeParserPool()

    await manifest.initialize()
    await vectors.initialize()
    await pool.start()
    logger.info("All storage engines initialized")

    yield AppContext(graph=graph, vectors=vectors, manifest=manifest, pool=pool)

    await pool.shutdown()
    await manifest.close()
    await graph.close()
    logger.info("All storage engines closed")


mcp = FastMCP("salesforce-lineage", lifespan=lifespan)


@mcp.tool()
async def ping(ctx: Context) -> str:
    """Health check tool — confirms lifespan context is wired correctly."""
    app: AppContext = ctx.request_context.lifespan_context
    pool_size = len(app.pool._workers)
    return f"ok — pool_size={pool_size}"


@mcp.tool()
async def ingest_org(export_dir: str, ctx: Context) -> str:
    """Ingest a Salesforce metadata export directory into the local graph."""
    app: AppContext = ctx.request_context.lifespan_context
    export_dir = _validate_workspace_export_dir(export_dir)
    service = IngestionService(
        graph=app.graph,
        manifest=app.manifest,
        pool=app.pool,
        vectors=app.vectors,
    )
    summary = await service.ingest(export_dir)
    return json.dumps(
        {
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
        },
        indent=2,
    )


@mcp.tool()
async def refresh(export_dir: str, ctx: Context) -> str:
    """Run incremental refresh for changed/new/deleted files."""
    app: AppContext = ctx.request_context.lifespan_context
    export_dir = _validate_workspace_export_dir(export_dir)
    service = IngestionService(
        graph=app.graph,
        manifest=app.manifest,
        pool=app.pool,
        vectors=app.vectors,
    )
    summary = await service.refresh(export_dir)
    return json.dumps(
        {
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
        },
        indent=2,
    )


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
    export_dir = _validate_workspace_export_dir(export_dir)
    service = IngestionService(
        graph=app.graph,
        manifest=app.manifest,
        pool=app.pool,
        vectors=app.vectors,
    )
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
    service = GraphQueryService(graph=app.graph, manifest=app.manifest, vectors=app.vectors)
    status = await service.get_ingestion_status()
    return json.dumps(status, indent=2)


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
    service = GraphQueryService(graph=app.graph, manifest=app.manifest, vectors=app.vectors)
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
    service = GraphQueryService(graph=app.graph, manifest=app.manifest, vectors=app.vectors)
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
    service = GraphQueryService(graph=app.graph, manifest=app.manifest, vectors=app.vectors)
    result = await service.get_node(node_id=node_id)
    return json.dumps(result, indent=2)


@mcp.tool()
async def explain_field(field_qualified_name: str, ctx: Context) -> str:
    """Return an evidence-backed reader/writer/dependent field impact summary."""
    app: AppContext = ctx.request_context.lifespan_context
    service = GraphQueryService(graph=app.graph, manifest=app.manifest, vectors=app.vectors)
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
    service = GraphQueryService(graph=app.graph, manifest=app.manifest, vectors=app.vectors)
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
    service = GraphQueryService(graph=app.graph, manifest=app.manifest, vectors=app.vectors)
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
    service = GraphQueryService(graph=app.graph, manifest=app.manifest, vectors=app.vectors)
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
    service = GraphQueryService(graph=app.graph, manifest=app.manifest, vectors=app.vectors)
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
    service = GraphQueryService(graph=app.graph, manifest=app.manifest, vectors=app.vectors)
    result = await service.test_gap_intelligence_from_git_diff(
        base_ref=base_ref,
        head_ref=head_ref,
        max_hops=max_hops,
        max_results_per_component=max_results_per_component,
    )
    return json.dumps(result, indent=2)


if __name__ == "__main__":
    mcp.run()
