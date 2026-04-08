from __future__ import annotations

import asyncio
import inspect
import json
import logging
import multiprocessing as mp
import queue
import threading
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from sfgraph.ingestion.models import IngestionSummary, RefreshSummary, VectorizeSummary
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


def _vector_health_payload(app: DaemonAppContext, progress: dict[str, Any] | None = None) -> dict[str, Any]:
    progress = progress or {}
    progress_health = progress.get("vector_health")
    if isinstance(progress_health, dict):
        return dict(progress_health)
    probe = getattr(app.vectors, "health_snapshot", None)
    if callable(probe):
        try:
            raw = probe()
            if inspect.isawaitable(raw):
                close = getattr(raw, "close", None)
                if callable(close):
                    close()
                raw = None
            if isinstance(raw, dict):
                return raw
        except Exception as exc:  # noqa: BLE001
            logger.debug("vector health probe failed", exc_info=True)
            return {"enabled": True, "status": "probe_failed", "error": str(exc)}
    return {"enabled": True, "status": "unknown"}


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
        ingest_factory=lambda export_dir, options, cancel_event: _run_job_in_worker_process(
            job_type="ingest",
            data_root=data_root,
            export_dir=export_dir,
            options=options,
            cancel_event=cancel_event,
        ),
        refresh_factory=lambda export_dir, options, cancel_event: _run_job_in_worker_process(
            job_type="refresh",
            data_root=data_root,
            export_dir=export_dir,
            options=options,
            cancel_event=cancel_event,
        ),
        vectorize_factory=lambda export_dir, options, cancel_event: _run_job_in_worker_process(
            job_type="vectorize",
            data_root=data_root,
            export_dir=export_dir,
            options=options,
            cancel_event=cancel_event,
        ),
        db_path=str(data_root / "ingest_jobs.sqlite"),
    )
    await manifest.initialize()
    await parse_cache.initialize()
    await vectors.initialize()
    await pool.start()
    await jobs.initialize()
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
    await app.jobs.close()
    await app.parse_cache.close()
    await app.manifest.close()
    await app.graph.close()


async def _close_runtime_parts(
    *,
    graph: DuckPGQStore,
    manifest: ManifestStore,
    parse_cache: ParseCache,
    pool: NodeParserPool,
) -> None:
    await pool.shutdown()
    await parse_cache.close()
    await manifest.close()
    await graph.close()


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
    cancel_event: threading.Event | None = None,
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
        cancel_event=cancel_event,
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


async def _run_isolated_job(
    *,
    job_type: str,
    data_root: Path,
    export_dir: str,
    options: dict[str, Any],
    cancel_event: threading.Event,
):
    graph = DuckPGQStore(db_path=str(data_root / "sfgraph.duckdb"))
    vectors = VectorStore(path=str(data_root / "vectors"))
    manifest = ManifestStore(db_path=str(data_root / "manifest.sqlite"))
    parse_cache = ParseCache(db_path=str(data_root / "parse_cache.sqlite"))
    pool = NodeParserPool()
    await manifest.initialize()
    await parse_cache.initialize()
    await vectors.initialize()
    await pool.start()
    try:
        mode = str(options.get("mode", "full"))
        resume_checkpoint = bool(options.get("resume_checkpoint", False))
        include_globs = _as_string_list(options.get("include_globs"))
        exclude_globs = _as_string_list(options.get("exclude_globs"))
        service = build_ingestion_service_from_parts(
            graph=graph,
            manifest=manifest,
            parse_cache=parse_cache,
            pool=pool,
            vectors=vectors,
            data_root=data_root,
            cancel_event=cancel_event,
            mode="full" if job_type == "vectorize" else mode,
            include_globs=[] if job_type == "vectorize" else include_globs,
            exclude_globs=[] if job_type == "vectorize" else exclude_globs,
        )
        if job_type == "ingest" and resume_checkpoint:
            logger.info(
                "Resuming ingest job via incremental refresh strategy for export_dir=%s",
                export_dir,
            )
            return await service.refresh(export_dir)
        if job_type == "ingest":
            return await service.ingest(export_dir)
        if job_type == "refresh":
            return await service.refresh(export_dir)
        if job_type == "vectorize":
            return await service.vectorize(export_dir)
        raise ValueError(f"Unsupported job type: {job_type}")
    finally:
        await _close_runtime_parts(
            graph=graph,
            manifest=manifest,
            parse_cache=parse_cache,
            pool=pool,
        )


def _run_isolated_job_entrypoint(
    *,
    result_queue: mp.Queue,
    job_type: str,
    data_root: str,
    export_dir: str,
    options: dict[str, Any],
) -> None:
    try:
        summary = asyncio.run(
            _run_isolated_job(
                job_type=job_type,
                data_root=Path(data_root),
                export_dir=export_dir,
                options=dict(options),
                cancel_event=threading.Event(),
            )
        )
        payload = summary.model_dump() if hasattr(summary, "model_dump") else dict(summary)
        result_queue.put({"ok": True, "payload": payload})
    except Exception as exc:  # noqa: BLE001
        result_queue.put({"ok": False, "error": str(exc)})


def _hydrate_job_summary(job_type: str, payload: dict[str, Any]):
    if job_type == "ingest":
        return IngestionSummary.model_validate(payload)
    if job_type == "refresh":
        return RefreshSummary.model_validate(payload)
    if job_type == "vectorize":
        return VectorizeSummary.model_validate(payload)
    raise ValueError(f"Unsupported job type: {job_type}")


async def _run_job_in_worker_process(
    *,
    job_type: str,
    data_root: Path,
    export_dir: str,
    options: dict[str, Any],
    cancel_event: threading.Event,
):
    ctx = mp.get_context("spawn")
    result_queue: mp.Queue = ctx.Queue(maxsize=1)
    process = ctx.Process(
        target=_run_isolated_job_entrypoint,
        kwargs={
            "result_queue": result_queue,
            "job_type": job_type,
            "data_root": str(data_root),
            "export_dir": export_dir,
            "options": dict(options),
        },
        daemon=True,
    )
    process.start()

    try:
        while True:
            if cancel_event.is_set():
                if process.is_alive():
                    process.terminate()
                    await asyncio.to_thread(process.join, 5.0)
                raise asyncio.CancelledError()

            try:
                message = result_queue.get_nowait()
            except queue.Empty:
                if not process.is_alive():
                    raise RuntimeError(
                        f"Background {job_type} process exited before emitting a result payload."
                    )
                await asyncio.sleep(0.1)
                continue

            if not isinstance(message, dict):
                raise RuntimeError(f"Background {job_type} process returned malformed payload.")
            if message.get("ok"):
                payload = message.get("payload")
                if not isinstance(payload, dict):
                    raise RuntimeError(f"Background {job_type} process returned invalid summary payload.")
                return _hydrate_job_summary(job_type, payload)
            raise RuntimeError(str(message.get("error") or f"{job_type} process failed"))
    finally:
        if process.is_alive():
            process.terminate()
            await asyncio.to_thread(process.join, 2.0)
        result_queue.close()
        result_queue.join_thread()


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
            "vector_health": _vector_health_payload(self.app),
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
        job["vector_health"] = _vector_health_payload(self.app, progress)
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

    async def resume_ingest_job(self, params: dict[str, Any]) -> dict[str, Any]:
        job_id = str(params["job_id"])
        try:
            return await self.app.jobs.resume_job(job_id)
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
            "vector_health": _vector_health_payload(self.app),
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
        payload = summary.model_dump()
        payload["vector_health"] = _vector_health_payload(self.app)
        return payload

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
        progress = read_progress_snapshot(self.app.data_root)
        if active_job is not None:
            status["active_job"] = _merge_job_with_progress(active_job, progress)
        else:
            status["active_job"] = None
        status["vector_health"] = _vector_health_payload(self.app, progress)
        return status

    async def get_ingestion_progress(self, params: dict[str, Any]) -> dict[str, Any]:
        _ = params
        service = build_query_service(self.app)
        payload = await service.get_ingestion_progress()
        active_job = await self.app.jobs.get_active_job()
        if active_job is not None:
            payload["active_job"] = active_job
        payload["vector_health"] = _vector_health_payload(self.app, payload)
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

    async def analyze_field(self, params: dict[str, Any]) -> dict[str, Any]:
        service = build_query_service(self.app)
        return await service.analyze_field(
            field_name=str(params["field_name"]),
            focus=str(params.get("focus", "both")),
            max_results=int(params.get("max_results", 100)),
        )

    async def analyze_object_event(self, params: dict[str, Any]) -> dict[str, Any]:
        service = build_query_service(self.app)
        return await service.analyze_object_event(
            object_name=str(params["object_name"]),
            event=str(params["event"]),
            max_results=int(params.get("max_results", 50)),
        )

    async def analyze_component(self, params: dict[str, Any]) -> dict[str, Any]:
        service = build_query_service(self.app)
        return await service.analyze_component(
            component_name=str(params["component_name"]),
            token=str(params["token"]) if params.get("token") is not None else None,
            focus=str(params.get("focus", "both")),
            max_results=int(params.get("max_results", 100)),
        )

    async def analyze_change(self, params: dict[str, Any]) -> dict[str, Any]:
        service = build_query_service(self.app)
        changed_files = params.get("changed_files")
        return await service.analyze_change(
            target=str(params["target"]) if params.get("target") is not None else None,
            changed_files=[str(item) for item in changed_files] if isinstance(changed_files, list) else None,
            max_hops=int(params.get("max_hops", 2)),
            max_results_per_component=int(params.get("max_results_per_component", 25)),
        )

    async def query(self, params: dict[str, Any]) -> dict[str, Any]:
        service = build_query_service(self.app)
        return await service.query(
            question=str(params["question"]),
            max_hops=int(params.get("max_hops", 3)),
            max_results=int(params.get("max_results", 50)),
            time_budget_ms=int(params.get("time_budget_ms", 1500)),
            offset=int(params.get("offset", 0)),
            allow_vector_fallback=bool(params.get("allow_vector_fallback", True)),
        )

    async def analyze(self, params: dict[str, Any]) -> dict[str, Any]:
        service = build_query_service(self.app)
        return await service.analyze(
            question=str(params["question"]),
            mode=str(params.get("mode", "auto")),
            strict=bool(params.get("strict", True)),
            max_results=int(params.get("max_results", 50)),
            max_hops=int(params.get("max_hops", 3)),
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
