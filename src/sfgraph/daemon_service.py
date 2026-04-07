from __future__ import annotations

import json
import logging
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from sfgraph.ingestion.job_manager import IngestJobManager
from sfgraph.ingestion.scope_migration import ScopeMigrationService
from sfgraph.ingestion.snapshot import GraphSnapshotService
from sfgraph.ingestion.service import IngestionService
from sfgraph.query.graph_query_service import GraphQueryService
from sfgraph.storage.duckpgq_store import DuckPGQStore
from sfgraph.storage.manifest_store import ManifestStore
from sfgraph.storage.parse_cache import ParseCache
from sfgraph.storage.vector_store import VectorStore
from sfgraph.parser.pool import NodeParserPool

logger = logging.getLogger(__name__)


@dataclass
class DaemonAppContext:
    graph: DuckPGQStore
    vectors: VectorStore
    manifest: ManifestStore
    parse_cache: ParseCache
    pool: NodeParserPool
    data_root: Path
    jobs: IngestJobManager


def _as_string_list(value: Any) -> list[str]:
    if value is None:
        return []
    if isinstance(value, list):
        return [str(item) for item in value if str(item)]
    return [str(value)] if str(value) else []


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


def _merge_job_with_progress(job: dict[str, Any], progress: dict[str, Any]) -> dict[str, Any]:
    payload = dict(job)
    if progress.get("available"):
        payload["progress"] = progress
    return payload


def read_progress_snapshot(data_root: Path) -> dict[str, Any]:
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


async def create_app_context(data_root: Path) -> DaemonAppContext:
    data_root.mkdir(parents=True, exist_ok=True)
    graph = DuckPGQStore(db_path=str(data_root / "sfgraph.duckdb"))
    vectors = VectorStore(path=str(data_root / "vectors"))
    manifest = ManifestStore(db_path=str(data_root / "manifest.sqlite"))
    parse_cache = ParseCache(db_path=str(data_root / "parse_cache.sqlite"))
    pool = NodeParserPool()
    jobs = IngestJobManager(
        ingest_factory=lambda export_dir, options: build_ingestion_service_from_parts(
            graph=graph,
            manifest=manifest,
            parse_cache=parse_cache,
            pool=pool,
            vectors=vectors,
            data_root=data_root,
            mode=str(options.get("mode", "full")),
            include_globs=_as_string_list(options.get("include_globs")),
            exclude_globs=_as_string_list(options.get("exclude_globs")),
        ).ingest(export_dir),
        refresh_factory=lambda export_dir, options: build_ingestion_service_from_parts(
            graph=graph,
            manifest=manifest,
            parse_cache=parse_cache,
            pool=pool,
            vectors=vectors,
            data_root=data_root,
            mode=str(options.get("mode", "full")),
            include_globs=_as_string_list(options.get("include_globs")),
            exclude_globs=_as_string_list(options.get("exclude_globs")),
        ).refresh(export_dir),
        vectorize_factory=lambda export_dir, options: build_ingestion_service_from_parts(
            graph=graph,
            manifest=manifest,
            parse_cache=parse_cache,
            pool=pool,
            vectors=vectors,
            data_root=data_root,
            mode="full",
            include_globs=[],
            exclude_globs=[],
        ).vectorize(export_dir),
    )
    await manifest.initialize()
    await parse_cache.initialize()
    await vectors.initialize()
    await pool.start()
    return DaemonAppContext(
        graph=graph,
        vectors=vectors,
        manifest=manifest,
        parse_cache=parse_cache,
        pool=pool,
        data_root=data_root,
        jobs=jobs,
    )


async def close_app_context(app: DaemonAppContext) -> None:
    await app.pool.shutdown()
    await app.parse_cache.close()
    await app.manifest.close()
    await app.graph.close()


def build_ingestion_service(app: DaemonAppContext) -> IngestionService:
    return build_ingestion_service_from_parts(
        graph=app.graph,
        manifest=app.manifest,
        parse_cache=app.parse_cache,
        pool=app.pool,
        vectors=app.vectors,
        data_root=app.data_root,
    )


def build_ingestion_service_from_parts(
    *,
    graph: DuckPGQStore,
    manifest: ManifestStore,
    parse_cache: ParseCache,
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
        parse_cache=parse_cache,
        pool=pool,
        vectors=vector_store,
        ingestion_meta_path=str(data_root / "ingestion_meta.json"),
        ingestion_progress_path=str(data_root / "ingestion_progress.json"),
        include_globs=include_globs,
        exclude_globs=exclude_globs,
    )


def build_query_service(app: DaemonAppContext) -> GraphQueryService:
    return GraphQueryService(
        graph=app.graph,
        manifest=app.manifest,
        vectors=app.vectors,
        repo_root=str(Path.cwd()),
        ingestion_meta_path=str(app.data_root / "ingestion_meta.json"),
        ingestion_progress_path=str(app.data_root / "ingestion_progress.json"),
    )


async def assert_no_active_background_job(app: DaemonAppContext, tool_name: str) -> None:
    active_job = await app.jobs.get_active_job()
    if active_job is None:
        return
    raise RuntimeError(
        f"{tool_name} cannot run while background job {active_job['job_id']} "
        f"({active_job['job_type']}) is {active_job['state']}. "
        "Wait for it to complete or cancel it first."
    )


class DaemonOperations:
    def __init__(self, app: DaemonAppContext) -> None:
        self.app = app

    async def ping(self, params: dict[str, Any]) -> dict[str, Any]:
        _ = params
        return {"ok": True, "pool_size": len(self.app.pool._workers)}

    async def ingest_org(self, params: dict[str, Any]) -> dict[str, Any]:
        await assert_no_active_background_job(self.app, "ingest_org")
        mode = str(params.get("mode", "full"))
        include_globs = _as_string_list(params.get("include_globs"))
        exclude_globs = _as_string_list(params.get("exclude_globs"))
        export_dir = str(params["export_dir"])
        service = build_ingestion_service_from_parts(
            graph=self.app.graph,
            manifest=self.app.manifest,
            parse_cache=self.app.parse_cache,
            pool=self.app.pool,
            vectors=self.app.vectors,
            data_root=self.app.data_root,
            mode=mode,
            include_globs=include_globs,
            exclude_globs=exclude_globs,
        )
        summary = await service.ingest(export_dir)
        return {
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
            "include_globs": include_globs,
            "exclude_globs": exclude_globs,
        }

    async def start_ingest_job(self, params: dict[str, Any]) -> dict[str, Any]:
        return await self.app.jobs.start_job(
            job_type="ingest",
            export_dir=str(params["export_dir"]),
            options={
                "mode": str(params.get("mode", "full")),
                "include_globs": _as_string_list(params.get("include_globs")),
                "exclude_globs": _as_string_list(params.get("exclude_globs")),
            },
        )

    async def start_refresh_job(self, params: dict[str, Any]) -> dict[str, Any]:
        return await self.app.jobs.start_job(
            job_type="refresh",
            export_dir=str(params["export_dir"]),
            options={
                "mode": str(params.get("mode", "full")),
                "include_globs": _as_string_list(params.get("include_globs")),
                "exclude_globs": _as_string_list(params.get("exclude_globs")),
            },
        )

    async def start_vectorize_job(self, params: dict[str, Any]) -> dict[str, Any]:
        return await self.app.jobs.start_job(
            job_type="vectorize",
            export_dir=str(params["export_dir"]),
            options={"mode": "full"},
        )

    async def get_ingest_job(self, params: dict[str, Any]) -> dict[str, Any]:
        job_id = str(params["job_id"])
        job = await self.app.jobs.get_job(job_id)
        if job is None:
            return {"job_id": job_id, "available": False, "error": "job_not_found"}
        progress = read_progress_snapshot(self.app.data_root)
        if self.app.jobs.active_job_id == job_id and progress.get("state") == "running":
            job = _merge_job_with_progress(job, progress)
        job["available"] = True
        return job

    async def list_ingest_jobs(self, params: dict[str, Any]) -> dict[str, Any]:
        _ = params
        jobs = await self.app.jobs.list_jobs()
        return {"active_job_id": self.app.jobs.active_job_id, "jobs": jobs}

    async def cancel_ingest_job(self, params: dict[str, Any]) -> dict[str, Any]:
        job_id = str(params["job_id"])
        try:
            return await self.app.jobs.cancel_job(job_id)
        except KeyError:
            return {"job_id": job_id, "available": False, "error": "job_not_found"}

    async def refresh(self, params: dict[str, Any]) -> dict[str, Any]:
        await assert_no_active_background_job(self.app, "refresh")
        mode = str(params.get("mode", "full"))
        include_globs = _as_string_list(params.get("include_globs"))
        exclude_globs = _as_string_list(params.get("exclude_globs"))
        export_dir = str(params["export_dir"])
        service = build_ingestion_service_from_parts(
            graph=self.app.graph,
            manifest=self.app.manifest,
            parse_cache=self.app.parse_cache,
            pool=self.app.pool,
            vectors=self.app.vectors,
            data_root=self.app.data_root,
            mode=mode,
            include_globs=include_globs,
            exclude_globs=exclude_globs,
        )
        summary = await service.refresh(export_dir)
        return {
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
            "include_globs": include_globs,
            "exclude_globs": exclude_globs,
        }

    async def vectorize(self, params: dict[str, Any]) -> dict[str, Any]:
        await assert_no_active_background_job(self.app, "vectorize")
        service = build_ingestion_service_from_parts(
            graph=self.app.graph,
            manifest=self.app.manifest,
            parse_cache=self.app.parse_cache,
            pool=self.app.pool,
            vectors=self.app.vectors,
            data_root=self.app.data_root,
            mode="full",
        )
        summary = await service.vectorize(str(params["export_dir"]))
        return summary.model_dump()

    async def watch_refresh(self, params: dict[str, Any]) -> dict[str, Any]:
        await assert_no_active_background_job(self.app, "watch_refresh")
        service = build_ingestion_service(self.app)
        return await service.watch_refresh(
            export_dir=str(params["export_dir"]),
            duration_seconds=int(params.get("duration_seconds", 60)),
            poll_interval=float(params.get("poll_interval", 1.0)),
            debounce_seconds=float(params.get("debounce_seconds", 2.0)),
            max_refreshes=int(params.get("max_refreshes", 25)),
        )

    async def get_ingestion_status(self, params: dict[str, Any]) -> dict[str, Any]:
        _ = params
        service = build_query_service(self.app)
        status = await service.get_ingestion_status()
        active_job = await self.app.jobs.get_active_job()
        if active_job is not None:
            progress = read_progress_snapshot(self.app.data_root)
            status["active_job"] = _merge_job_with_progress(active_job, progress)
        else:
            status["active_job"] = None
        return status

    async def get_ingestion_progress(self, params: dict[str, Any]) -> dict[str, Any]:
        _ = params
        service = build_query_service(self.app)
        payload = await service.get_ingestion_progress()
        active_job = await self.app.jobs.get_active_job()
        if active_job is not None:
            payload["active_job"] = active_job
        return payload

    async def trace_upstream(self, params: dict[str, Any]) -> dict[str, Any]:
        service = build_query_service(self.app)
        return await service.trace_upstream(
            start_node=str(params["node_id"]),
            max_hops=int(params.get("max_hops", 3)),
            max_results=int(params.get("max_results", 50)),
            time_budget_ms=int(params.get("time_budget_ms", 1500)),
            offset=int(params.get("offset", 0)),
        )

    async def trace_downstream(self, params: dict[str, Any]) -> dict[str, Any]:
        service = build_query_service(self.app)
        return await service.trace_downstream(
            start_node=str(params["node_id"]),
            max_hops=int(params.get("max_hops", 3)),
            max_results=int(params.get("max_results", 50)),
            time_budget_ms=int(params.get("time_budget_ms", 1500)),
            offset=int(params.get("offset", 0)),
        )

    async def get_node(self, params: dict[str, Any]) -> dict[str, Any]:
        service = build_query_service(self.app)
        return await service.get_node(node_id=str(params["node_id"]))

    async def explain_field(self, params: dict[str, Any]) -> dict[str, Any]:
        service = build_query_service(self.app)
        return await service.explain_field(field_qualified_name=str(params["field_qualified_name"]))

    async def query(self, params: dict[str, Any]) -> dict[str, Any]:
        service = build_query_service(self.app)
        return await service.query(
            question=str(params["question"]),
            max_hops=int(params.get("max_hops", 3)),
            max_results=int(params.get("max_results", 50)),
            time_budget_ms=int(params.get("time_budget_ms", 1500)),
            offset=int(params.get("offset", 0)),
        )

    async def impact_from_git_diff(self, params: dict[str, Any]) -> dict[str, Any]:
        service = build_query_service(self.app)
        return await service.impact_from_git_diff(
            base_ref=str(params.get("base_ref", "HEAD~1")),
            head_ref=str(params.get("head_ref", "HEAD")),
            max_hops=int(params.get("max_hops", 2)),
            max_results_per_component=int(params.get("max_results_per_component", 25)),
        )

    async def cross_layer_flow_map(self, params: dict[str, Any]) -> dict[str, Any]:
        service = build_query_service(self.app)
        return await service.cross_layer_flow_map(
            start_node=str(params["node_id"]),
            max_hops=int(params.get("max_hops", 5)),
            max_results=int(params.get("max_results", 50)),
            time_budget_ms=int(params.get("time_budget_ms", 2500)),
            offset=int(params.get("offset", 0)),
        )

    async def list_unknown_dynamic_edges(self, params: dict[str, Any]) -> dict[str, Any]:
        service = build_query_service(self.app)
        return await service.list_unknown_dynamic_edges(
            limit=int(params.get("limit", 200)),
            offset=int(params.get("offset", 0)),
        )

    async def create_snapshot(self, params: dict[str, Any]) -> dict[str, Any]:
        snapshot_service = GraphSnapshotService(graph=self.app.graph)
        return await snapshot_service.create_snapshot(name=params.get("name"))

    async def diff_snapshots(self, params: dict[str, Any]) -> dict[str, Any]:
        return GraphSnapshotService.diff_snapshots(
            snapshot_a_path=str(params["snapshot_a_path"]),
            snapshot_b_path=str(params["snapshot_b_path"]),
            max_examples=int(params.get("max_examples", 200)),
        )

    async def migrate_project_scope(self, params: dict[str, Any]) -> dict[str, Any]:
        service = ScopeMigrationService(graph=self.app.graph, vectors=self.app.vectors)
        return await service.migrate_project_scope(
            export_dir=str(params["export_dir"]),
            dry_run=bool(params.get("dry_run", True)),
            prune_legacy=bool(params.get("prune_legacy", False)),
        )

    async def test_gap_intelligence_from_git_diff(self, params: dict[str, Any]) -> dict[str, Any]:
        service = build_query_service(self.app)
        return await service.test_gap_intelligence_from_git_diff(
            base_ref=str(params.get("base_ref", "HEAD~1")),
            head_ref=str(params.get("head_ref", "HEAD")),
            max_hops=int(params.get("max_hops", 2)),
            max_results_per_component=int(params.get("max_results_per_component", 25)),
        )

    async def dispatch(self, method: str, params: dict[str, Any]) -> dict[str, Any]:
        handler = getattr(self, method, None)
        if handler is None or method.startswith("_"):
            raise KeyError(method)
        result = await handler(params)
        if isinstance(result, dict):
            return result
        raise TypeError(f"Unsupported result type for {method}: {type(result)!r}")
