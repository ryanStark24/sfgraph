"""IngestionService two-phase orchestration + incremental refresh."""
from __future__ import annotations

import asyncio
import hashlib
import json
import logging
import os
import fnmatch
import subprocess
import threading
import time
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from sfgraph.common import compute_sha256, parse_json_props
from sfgraph.ingestion.constants import NODE_WRITE_ORDER
from sfgraph.ingestion.models import (
    EdgeFact,
    IngestionPhase,
    IngestionSummary,
    NodeFact,
    RefreshSummary,
    VectorizeSummary,
)
from sfgraph.ingestion.schema_index import materialize_schema_index
from sfgraph.parser.apex_extractor import ApexExtractor
from sfgraph.parser.dynamic_accessor import DynamicAccessorRegistry
from sfgraph.parser.flow_parser import parse_flow_xml
from sfgraph.parser.lwc_parser import parse_lwc_file
from sfgraph.parser.object_parser import (
    parse_custom_metadata_record_xml,
    parse_global_value_set_xml,
    parse_labels_xml,
    parse_object_dir,
)
from sfgraph.parser.pool import NodeParserPool
from sfgraph.parser.vlocity_parser import (
    is_vlocity_datapack_file,
    parse_vlocity_json_detailed,
)
from sfgraph.storage.base import GraphStore
from sfgraph.storage.manifest_store import ManifestStore
from sfgraph.storage.parse_cache import ParseCache
from sfgraph.storage.vector_store import VectorStore

logger = logging.getLogger(__name__)
TRANSIENT_WORKER_ERRORS = frozenset({"worker_restarting", "worker_exited", "timeout", "no_workers"})

def _format_parser_failure_details(payload: Any) -> str:
    if not isinstance(payload, dict):
        return ""
    details: list[str] = []
    worker_stderr = str(payload.get("worker_stderr") or "").strip()
    if worker_stderr:
        details.append(f"worker_stderr={worker_stderr}")
    error_line = payload.get("errorLine")
    error_column = payload.get("errorColumn")
    if error_line is not None:
        if error_column is not None:
            details.append(f"error_location=line {error_line}, col {error_column}")
        else:
            details.append(f"error_line={error_line}")
    error_node_type = payload.get("errorNodeType")
    if error_node_type:
        details.append(f"error_node={error_node_type}")
    file_size = payload.get("fileSizeBytes")
    if isinstance(file_size, int):
        details.append(f"file_size_bytes={file_size}")
    class_names = payload.get("classNames")
    if isinstance(class_names, list) and class_names:
        details.append("classes=" + ",".join(str(name) for name in class_names[:5]))
    top_level = payload.get("topLevelKinds")
    if isinstance(top_level, list) and top_level:
        details.append("top_level=" + ",".join(str(kind) for kind in top_level[:8]))
    context_snippet = str(payload.get("contextSnippet") or "").strip()
    if context_snippet:
        compact = " ".join(context_snippet.split())
        details.append(f"context={compact[:220]}")
    exception_name = payload.get("exceptionName")
    if exception_name:
        details.append(f"exception={exception_name}")
    return " | ".join(details)


class IngestionService:
    """Two-phase ingestion pipeline for Salesforce metadata exports."""

    SCHEMA_INDEX_PATH = "./data/schema_index.json"
    INGESTION_META_PATH = "./data/ingestion_meta.json"
    INGESTION_PROGRESS_PATH = "./data/ingestion_progress.json"
    SKIP_DIR_NAMES = frozenset(
        {
            ".git",
            ".hg",
            ".svn",
            ".sfdx",
            ".sf",
            "node_modules",
            ".venv",
            "venv",
            "__pycache__",
            ".pytest_cache",
            ".mypy_cache",
            ".cache",
            "dist",
            "build",
        }
    )
    SKIP_FILE_PREFIXES = ("~$",)
    SKIP_FILE_SUFFIXES = (".tmp", ".swp", ".swo")
    DEFAULT_DISCOVERY_ROOTS = ("force-app", "vlocity")

    def __init__(
        self,
        graph: GraphStore,
        manifest: ManifestStore,
        pool: NodeParserPool,
        vectors: VectorStore | None = None,
        parse_cache: ParseCache | None = None,
        cancel_event: threading.Event | None = None,
        schema_index_path: str | None = None,
        ingestion_meta_path: str | None = None,
        ingestion_progress_path: str | None = None,
        include_globs: list[str] | None = None,
        exclude_globs: list[str] | None = None,
    ) -> None:
        self._graph = graph
        self._manifest = manifest
        self._pool = pool
        self._vectors = vectors
        self._parse_cache = parse_cache
        self._cancel_event = cancel_event
        self._schema_index_path = schema_index_path or self.SCHEMA_INDEX_PATH
        self._ingestion_meta_path = ingestion_meta_path or self.INGESTION_META_PATH
        self._ingestion_progress_path = ingestion_progress_path or self.INGESTION_PROGRESS_PATH
        self._apex_extractor = ApexExtractor()
        self._dynamic_registry = DynamicAccessorRegistry()
        self._active_project_scope: str | None = None
        self._active_export_root: Path | None = None
        self._progress_started_at: str | None = None
        self._last_progress_flush_at: float = 0.0
        self._include_globs = include_globs or []
        self._exclude_globs = exclude_globs or []

    def _raise_if_cancelled(self) -> None:
        if self._cancel_event is not None and self._cancel_event.is_set():
            raise asyncio.CancelledError("cancelled")

    @staticmethod
    def _serialize_parse_result(
        nodes: list[NodeFact],
        edges: list[EdgeFact],
        metadata: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        return {
            "nodes": [node.model_dump() for node in nodes],
            "edges": [edge.model_dump() for edge in edges],
            "metadata": metadata or {},
        }

    @staticmethod
    def _deserialize_parse_result(payload: dict[str, Any]) -> tuple[list[NodeFact], list[EdgeFact], dict[str, Any]]:
        raw_nodes = payload.get("nodes") if isinstance(payload, dict) else []
        raw_edges = payload.get("edges") if isinstance(payload, dict) else []
        metadata = payload.get("metadata") if isinstance(payload, dict) else {}
        nodes = [NodeFact.model_validate(node) for node in raw_nodes or []]
        edges = [EdgeFact.model_validate(edge) for edge in raw_edges or []]
        return nodes, edges, metadata if isinstance(metadata, dict) else {}

    @staticmethod
    def _cacheable_parser(parser_name: str) -> bool:
        # Object parsing walks an entire object directory, so a single file hash
        # is not a safe cache key for it.
        return parser_name not in {"object", "unknown"}

    @staticmethod
    def _parse_cache_namespace(parser_name: str, fpath: str) -> str:
        # Some parsers derive stable identities from the file path rather than
        # only the file content. Keep those cache entries path-scoped so
        # identical content in different files cannot alias to the same graph ids.
        if parser_name in {"apex", "flow", "lwc", "vlocity"}:
            path_digest = hashlib.sha1(str(Path(fpath).resolve()).encode("utf-8")).hexdigest()[:16]
            return f"{parser_name}@{path_digest}"
        return parser_name

    @staticmethod
    def _rebind_cached_nodes(nodes: list[NodeFact], fpath: str) -> list[NodeFact]:
        rebound: list[NodeFact] = []
        for node in nodes:
            props = dict(node.all_props)
            props["sourceFile"] = fpath
            rebound.append(node.model_copy(update={"sourceFile": fpath, "all_props": props}))
        return rebound

    @staticmethod
    def _compute_project_scope(export_dir: str) -> str:
        export_path = Path(export_dir).expanduser().resolve()
        return hashlib.sha1(str(export_path).encode("utf-8")).hexdigest()[:12]

    @staticmethod
    def _stat_fingerprint_matches(tracked_file: dict[str, Any] | None, stat_result: os.stat_result) -> bool:
        if not tracked_file:
            return False
        if tracked_file.get("sha256") in {None, ""}:
            return False
        if tracked_file.get("size_bytes") != stat_result.st_size:
            return False
        if tracked_file.get("mtime_ns") != stat_result.st_mtime_ns:
            return False
        tracked_ctime = tracked_file.get("ctime_ns")
        current_ctime = getattr(stat_result, "st_ctime_ns", None)
        if tracked_ctime is None or current_ctime is None:
            return False
        return tracked_ctime == current_ctime

    def _activate_scope(self, export_dir: str) -> str:
        resolved = str(Path(export_dir).expanduser().resolve())
        self._active_project_scope = self._compute_project_scope(resolved)
        self._active_export_root = Path(resolved)
        return resolved

    @staticmethod
    def _descope_qname(qualified_name: str) -> str:
        if "::" not in qualified_name:
            return qualified_name
        return qualified_name.split("::", 1)[1]

    def _scope_qname(self, qualified_name: str) -> str:
        if not qualified_name:
            return qualified_name
        if "::" in qualified_name:
            return qualified_name
        if not self._active_project_scope:
            return qualified_name
        return f"{self._active_project_scope}::{qualified_name}"

    def _scope_node_fact(self, node_fact: NodeFact) -> NodeFact:
        key_props = dict(node_fact.key_props)
        all_props = dict(node_fact.all_props)
        raw_qname = str(key_props.get("qualifiedName") or all_props.get("qualifiedName") or "")
        scoped_qname = self._scope_qname(raw_qname) if raw_qname else ""
        if scoped_qname:
            key_props["qualifiedName"] = scoped_qname
            all_props["scopedQualifiedName"] = scoped_qname
        if raw_qname:
            all_props["qualifiedName"] = raw_qname
        if self._active_project_scope:
            all_props["projectScope"] = self._active_project_scope
        return node_fact.model_copy(
            update={
                "key_props": key_props,
                "all_props": all_props,
            }
        )

    def _scope_edge_fact(self, edge_fact: EdgeFact) -> EdgeFact:
        return edge_fact.model_copy(
            update={
                "src_qualified_name": self._scope_qname(edge_fact.src_qualified_name),
                "dst_qualified_name": self._scope_qname(edge_fact.dst_qualified_name),
            }
        )

    def _stub_node_props(self, scoped_qname: str, label: str) -> dict[str, Any]:
        unscoped_qname = self._descope_qname(scoped_qname)
        return {
            "qualifiedName": unscoped_qname,
            "scopedQualifiedName": scoped_qname,
            "name": unscoped_qname.split(".")[-1],
            "projectScope": self._active_project_scope,
            "unresolvable": True,
            "stubLabel": label,
            "sourceFile": "stub",
            "lineNumber": 0,
            "parserType": "stub",
            "lastIngestedAt": datetime.now(timezone.utc).isoformat(),
        }

    @staticmethod
    def _node_vector_text(all_props: dict[str, Any]) -> str:
        parts = [
            str(all_props.get("qualifiedName", "")),
            str(all_props.get("name", "")),
            str(all_props.get("label", "")),
            str(all_props.get("sourceFile", "")),
            str(all_props.get("parserType", "")),
        ]
        return " | ".join(p for p in parts if p)

    async def _upsert_vector_for_node(self, scoped_qname: str, props: dict[str, Any]) -> bool:
        if not self._vectors:
            return False
        text = self._node_vector_text(props)
        if not text:
            return False
        payload = {
            "qualifiedName": props.get("qualifiedName"),
            "scopedQualifiedName": scoped_qname,
            "label": props.get("label"),
            "sourceFile": props.get("sourceFile"),
            "parserType": props.get("parserType"),
        }
        try:
            await self._vectors.upsert(
                node_id=scoped_qname,
                text=text,
                payload=payload,
                project_scope=self._active_project_scope,
            )
            return True
        except Exception as exc:  # noqa: BLE001
            logger.warning("Vector upsert failed for %s: %s", scoped_qname, exc)
            return False

    async def _delete_vectors_for_nodes(self, node_qnames: set[str]) -> None:
        if not self._vectors or not node_qnames:
            return
        try:
            await self._vectors.delete_by_node_ids(sorted(node_qnames))
        except Exception as exc:  # noqa: BLE001
            logger.warning("Vector delete failed for %d nodes: %s", len(node_qnames), exc)

    async def vectorize(self, export_dir: str) -> VectorizeSummary:
        """Rebuild vectors for all nodes in the active project scope."""
        export_dir = self._activate_scope(export_dir)
        start = time.monotonic()
        run_id = await self._manifest.create_run()
        warnings: list[str] = []
        self._progress_started_at = datetime.now(timezone.utc).isoformat()
        self._last_progress_flush_at = 0.0

        if not self._vectors:
            raise RuntimeError("Vector store is disabled for this runtime. Re-run with mode=full to enable vectors.")

        rows_by_label = await self._load_scoped_nodes_with_props()
        total_nodes = sum(len(rows) for rows in rows_by_label.values())
        self._write_progress_snapshot(
            {
                "run_id": run_id,
                "mode": "vectorize",
                "state": "running",
                "phase": "vectorizing",
                "export_dir": export_dir,
                "project_scope": self._active_project_scope,
                "started_at": self._progress_started_at,
                "updated_at": self._progress_started_at,
                "total_files": total_nodes,
                "processed_files": 0,
                "failed_files": 0,
                "current_file": None,
                "current_parser": "vector",
                "parser_stats": self._empty_parser_stats(),
                "unresolved_symbols": 0,
                "node_counts_by_type": {},
                "edge_count": 0,
                "orphaned_edges": 0,
                "warnings_count": 0,
            },
            force=True,
        )

        if self._active_project_scope:
            deleted = await self._vectors.delete_by_project_scope(self._active_project_scope)
            if deleted:
                logger.info("Deleted %d existing vectors for project scope %s", deleted, self._active_project_scope)

        processed_nodes = 0
        failed_nodes = 0
        skipped_nodes = 0
        node_counts_by_type: dict[str, int] = {}
        for label, rows in rows_by_label.items():
            node_counts_by_type[label] = len(rows)
            for qname, props in rows:
                text = self._node_vector_text(props)
                if not text:
                    skipped_nodes += 1
                    continue
                upserted = await self._upsert_vector_for_node(qname, props | {"label": label})
                if upserted:
                    processed_nodes += 1
                else:
                    failed_nodes += 1
                    warnings.append(f"Vector upsert failed for {qname}")
                self._write_progress_snapshot(
                    {
                        "run_id": run_id,
                        "mode": "vectorize",
                        "state": "running",
                        "phase": "vectorizing",
                        "export_dir": export_dir,
                        "project_scope": self._active_project_scope,
                        "started_at": self._progress_started_at,
                        "total_files": total_nodes,
                        "processed_files": processed_nodes + skipped_nodes,
                        "failed_files": failed_nodes,
                        "current_file": qname,
                        "current_parser": "vector",
                        "parser_stats": self._empty_parser_stats(),
                        "unresolved_symbols": 0,
                        "node_counts_by_type": node_counts_by_type,
                        "edge_count": 0,
                        "orphaned_edges": 0,
                        "warnings_count": len(warnings),
                    }
                )

        await self._manifest.mark_run_complete(
            run_id,
            phase_1_complete=True,
            phase_2_complete=True,
        )
        duration = round(time.monotonic() - start, 3)
        summary = VectorizeSummary(
            run_id=run_id,
            export_dir=export_dir,
            duration_seconds=duration,
            processed_nodes=processed_nodes,
            failed_nodes=failed_nodes,
            skipped_nodes=skipped_nodes,
            warnings=warnings,
        )
        self._write_progress_snapshot(
            {
                "run_id": run_id,
                "mode": "vectorize",
                "state": "completed",
                "phase": "completed",
                "export_dir": export_dir,
                "project_scope": self._active_project_scope,
                "started_at": self._progress_started_at,
                "completed_at": datetime.now(timezone.utc).isoformat(),
                "duration_seconds": duration,
                "total_files": total_nodes,
                "processed_files": processed_nodes + skipped_nodes,
                "failed_files": failed_nodes,
                "current_file": None,
                "current_parser": "vector",
                "parser_stats": self._empty_parser_stats(),
                "unresolved_symbols": 0,
                "node_counts_by_type": node_counts_by_type,
                "edge_count": 0,
                "orphaned_edges": 0,
                "warnings_count": len(warnings),
            },
            force=True,
        )
        return summary

    def _belongs_to_active_scope(self, qualified_name: str, props: dict[str, Any]) -> bool:
        if not self._active_project_scope:
            return True

        prop_scope = props.get("projectScope")
        if isinstance(prop_scope, str) and prop_scope:
            return prop_scope == self._active_project_scope

        if qualified_name.startswith(f"{self._active_project_scope}::"):
            return True

        source = props.get("sourceFile")
        if not source or not self._active_export_root:
            return False
        try:
            source_path = Path(str(source)).expanduser().resolve()
            return source_path == self._active_export_root or self._active_export_root in source_path.parents
        except Exception:
            return False

    async def ingest(self, export_dir: str) -> IngestionSummary:
        """Ingest a metadata export directory and return summary statistics."""
        export_dir = self._activate_scope(export_dir)
        start = time.monotonic()
        run_id = await self._manifest.create_run()
        warnings: list[str] = []
        self._progress_started_at = datetime.now(timezone.utc).isoformat()
        self._last_progress_flush_at = 0.0
        discovered_files = await self._discover_file_records(
            Path(export_dir),
            run_id=run_id,
            mode="full_ingest",
        )
        self._write_progress_snapshot(
            {
                "run_id": run_id,
                "mode": "full_ingest",
                "state": "running",
                "phase": "discovering",
                "export_dir": export_dir,
                "project_scope": self._active_project_scope,
                "started_at": self._progress_started_at,
                "updated_at": self._progress_started_at,
                "total_files": len(discovered_files),
                "processed_files": 0,
                "failed_files": 0,
                "current_file": None,
                "parser_stats": self._empty_parser_stats(),
                "unresolved_symbols": 0,
                "node_counts_by_type": {},
                "edge_count": 0,
                "orphaned_edges": 0,
                "warnings_count": 0,
            },
            force=True,
        )
        for fpath, meta in discovered_files.items():
            await self._manifest.upsert_file(
                fpath,
                meta["sha256"],
                run_id,
                size_bytes=meta.get("size_bytes"),
                mtime_ns=meta.get("mtime_ns"),
            )

        facts_by_type, all_edges, parse_failures, parser_stats, unresolved_symbols = await self._collect_facts(
            list(discovered_files.keys()),
            file_records=discovered_files,
            run_id=run_id,
            mode="full_ingest",
            total_files=len(discovered_files),
        )

        self._write_progress_snapshot(
            {
                "run_id": run_id,
                "mode": "full_ingest",
                "state": "running",
                "phase": "writing_nodes",
                "export_dir": export_dir,
                "project_scope": self._active_project_scope,
                "started_at": self._progress_started_at,
                "total_files": len(discovered_files),
                "processed_files": len(discovered_files),
                "failed_files": len(parse_failures),
                "current_file": None,
                "parser_stats": parser_stats,
                "unresolved_symbols": unresolved_symbols,
                "node_counts_by_type": {},
                "edge_count": 0,
                "orphaned_edges": 0,
                "warnings_count": len(warnings),
            },
            force=True,
        )
        node_counts, written_qnames = await self._write_nodes(facts_by_type)

        for fpath in discovered_files:
            if fpath not in parse_failures:
                await self._manifest.set_status(fpath, "NODES_WRITTEN")

        node_registry = await self._load_node_registry()
        scoped_edges = [self._scope_edge_fact(edge) for edge in self._apply_picklist_guard(all_edges, facts_by_type)]
        self._write_progress_snapshot(
            {
                "run_id": run_id,
                "mode": "full_ingest",
                "state": "running",
                "phase": "writing_edges",
                "export_dir": export_dir,
                "project_scope": self._active_project_scope,
                "started_at": self._progress_started_at,
                "total_files": len(discovered_files),
                "processed_files": len(discovered_files),
                "failed_files": len(parse_failures),
                "current_file": None,
                "parser_stats": parser_stats,
                "unresolved_symbols": unresolved_symbols,
                "node_counts_by_type": dict(node_counts),
                "edge_count": 0,
                "orphaned_edges": 0,
                "warnings_count": len(warnings),
            },
            force=True,
        )
        edge_count, orphaned_edges, edge_warnings = await self._write_edges(
            scoped_edges,
            node_registry=node_registry,
        )
        warnings.extend(edge_warnings)

        for fpath in discovered_files:
            if fpath not in parse_failures:
                await self._manifest.set_status(fpath, "EDGES_WRITTEN")

        await self._manifest.mark_run_complete(
            run_id,
            phase_1_complete=True,
            phase_2_complete=True,
        )

        try:
            await materialize_schema_index(self._graph, self._schema_index_path)
        except Exception as exc:  # noqa: BLE001
            warnings.append(f"Schema index failed: {exc}")

        duration = round(time.monotonic() - start, 3)
        summary = IngestionSummary(
            run_id=run_id,
            export_dir=export_dir,
            duration_seconds=duration,
            node_counts_by_type=dict(node_counts),
            edge_count=edge_count,
            parse_failures=parse_failures,
            orphaned_edges=orphaned_edges,
            warnings=warnings,
            parser_stats=parser_stats,
            unresolved_symbols=unresolved_symbols,
        )
        self._write_ingestion_meta(summary)
        self._write_progress_snapshot(
            {
                "run_id": run_id,
                "mode": "full_ingest",
                "state": "completed",
                "phase": "completed",
                "export_dir": export_dir,
                "project_scope": self._active_project_scope,
                "started_at": self._progress_started_at,
                "completed_at": datetime.now(timezone.utc).isoformat(),
                "duration_seconds": duration,
                "total_files": len(discovered_files),
                "processed_files": len(discovered_files),
                "failed_files": len(parse_failures),
                "current_file": None,
                "parser_stats": parser_stats,
                "unresolved_symbols": unresolved_symbols,
                "node_counts_by_type": dict(node_counts),
                "edge_count": edge_count,
                "orphaned_edges": orphaned_edges,
                "warnings_count": len(warnings),
            },
            force=True,
        )
        return summary

    async def refresh(self, export_dir: str) -> RefreshSummary:
        """Incrementally refresh changed/new/deleted files based on manifest delta."""
        export_dir = self._activate_scope(export_dir)
        start = time.monotonic()
        run_id = await self._manifest.create_run()
        warnings: list[str] = []
        self._progress_started_at = datetime.now(timezone.utc).isoformat()
        self._last_progress_flush_at = 0.0

        current_files = await self._discover_file_records(
            Path(export_dir),
            run_id=run_id,
            mode="incremental_refresh",
        )
        delta = await self._manifest.get_delta(current_files)
        changed_files = sorted(set(delta["new"] + delta["changed"]))
        deleted_files = sorted(delta["deleted"])
        affected_neighbor_files: list[str] = []

        # REFRESH-04: conservative affected-neighbor rediscovery.
        seed_nodes = await self._nodes_for_source_files(changed_files + deleted_files)
        neighbor_nodes = await self._collect_neighbor_nodes(seed_nodes)
        neighbor_files = await self._source_files_for_nodes(neighbor_nodes)
        for fpath in sorted(neighbor_files):
            if fpath in current_files and fpath not in deleted_files and fpath not in changed_files:
                affected_neighbor_files.append(fpath)
        reparse_files = sorted(set(changed_files + affected_neighbor_files))
        self._write_progress_snapshot(
            {
                "run_id": run_id,
                "mode": "incremental_refresh",
                "state": "running",
                "phase": "planning_refresh",
                "export_dir": export_dir,
                "project_scope": self._active_project_scope,
                "started_at": self._progress_started_at,
                "updated_at": self._progress_started_at,
                "total_files": len(reparse_files),
                "processed_files": 0,
                "failed_files": 0,
                "current_file": None,
                "changed_files": changed_files,
                "deleted_files": deleted_files,
                "affected_neighbor_files": affected_neighbor_files,
                "parser_stats": self._empty_parser_stats(),
                "unresolved_symbols": 0,
                "node_count": 0,
                "edge_count": 0,
                "orphaned_edges": 0,
                "warnings_count": 0,
            },
            force=True,
        )

        # Deleted files: drop sourced nodes and manifest entries.
        if deleted_files:
            removed_qnames = await self._purge_nodes_by_source_files(deleted_files)
            await self._delete_edges_for_nodes(removed_qnames)
            await self._delete_vectors_for_nodes(removed_qnames)
            await self._manifest.delete_files(deleted_files)

        # Changed/new files: replace sourced nodes and rewrite their edges.
        node_count = 0
        edge_count = 0
        orphaned_edges = 0

        parse_failures: list[str] = []
        parser_stats = self._empty_parser_stats()
        unresolved_symbols = 0

        if reparse_files:
            for fpath in reparse_files:
                meta = current_files.get(fpath)
                if meta:
                    await self._manifest.upsert_file(
                        fpath,
                        meta["sha256"],
                        run_id,
                        size_bytes=meta.get("size_bytes"),
                        mtime_ns=meta.get("mtime_ns"),
                    )

            removed_qnames = await self._purge_nodes_by_source_files(reparse_files)
            await self._delete_edges_for_nodes(removed_qnames)
            await self._delete_vectors_for_nodes(removed_qnames)

            facts_by_type, all_edges, parse_failures, parser_stats, unresolved_symbols = await self._collect_facts(
                reparse_files,
                file_records=current_files,
                run_id=run_id,
                mode="incremental_refresh",
                total_files=len(reparse_files),
                changed_files=changed_files,
                deleted_files=deleted_files,
                affected_neighbor_files=affected_neighbor_files,
            )
            self._write_progress_snapshot(
                {
                    "run_id": run_id,
                    "mode": "incremental_refresh",
                    "state": "running",
                    "phase": "writing_nodes",
                    "export_dir": export_dir,
                    "project_scope": self._active_project_scope,
                    "started_at": self._progress_started_at,
                    "total_files": len(reparse_files),
                    "processed_files": len(reparse_files),
                    "failed_files": len(parse_failures),
                    "current_file": None,
                    "changed_files": changed_files,
                    "deleted_files": deleted_files,
                    "affected_neighbor_files": affected_neighbor_files,
                    "parser_stats": parser_stats,
                    "unresolved_symbols": unresolved_symbols,
                    "node_count": 0,
                    "edge_count": 0,
                    "orphaned_edges": 0,
                    "warnings_count": len(warnings),
                },
                force=True,
            )
            node_counts, written_qnames = await self._write_nodes(facts_by_type)
            node_count = sum(node_counts.values())

            for fpath in reparse_files:
                if fpath not in parse_failures:
                    await self._manifest.set_status(fpath, "NODES_WRITTEN")

            # Remove stale edges connected to rewritten nodes before adding new ones.
            await self._delete_edges_for_nodes(written_qnames)

            node_registry = await self._load_node_registry()
            scoped_edges = [self._scope_edge_fact(edge) for edge in self._apply_picklist_guard(all_edges, facts_by_type)]
            self._write_progress_snapshot(
                {
                    "run_id": run_id,
                    "mode": "incremental_refresh",
                    "state": "running",
                    "phase": "writing_edges",
                    "export_dir": export_dir,
                    "project_scope": self._active_project_scope,
                    "started_at": self._progress_started_at,
                    "total_files": len(reparse_files),
                    "processed_files": len(reparse_files),
                    "failed_files": len(parse_failures),
                    "current_file": None,
                    "changed_files": changed_files,
                    "deleted_files": deleted_files,
                    "affected_neighbor_files": affected_neighbor_files,
                    "parser_stats": parser_stats,
                    "unresolved_symbols": unresolved_symbols,
                    "node_count": node_count,
                    "edge_count": 0,
                    "orphaned_edges": 0,
                    "warnings_count": len(warnings),
                },
                force=True,
            )
            edge_count, orphaned_edges, edge_warnings = await self._write_edges(
                scoped_edges,
                node_registry=node_registry,
            )
            warnings.extend(edge_warnings)

            for fpath in reparse_files:
                if fpath not in parse_failures:
                    await self._manifest.set_status(fpath, "EDGES_WRITTEN")

        # Always prune dangling edges after deletes/updates.
        await self._prune_dangling_edges()

        await self._manifest.mark_run_complete(
            run_id,
            phase_1_complete=True,
            phase_2_complete=True,
        )

        try:
            await materialize_schema_index(self._graph, self._schema_index_path)
        except Exception as exc:  # noqa: BLE001
            warnings.append(f"Schema index failed: {exc}")

        duration = round(time.monotonic() - start, 3)
        summary = RefreshSummary(
            run_id=run_id,
            export_dir=export_dir,
            duration_seconds=duration,
            processed_files=len(reparse_files),
            changed_files=changed_files,
            deleted_files=deleted_files,
            affected_neighbor_files=affected_neighbor_files,
            node_count=node_count,
            edge_count=edge_count,
            orphaned_edges=orphaned_edges,
            warnings=warnings,
            parser_stats=parser_stats,
            unresolved_symbols=unresolved_symbols,
        )
        self._write_refresh_meta(summary)
        self._write_progress_snapshot(
            {
                "run_id": run_id,
                "mode": "incremental_refresh",
                "state": "completed",
                "phase": "completed",
                "export_dir": export_dir,
                "project_scope": self._active_project_scope,
                "started_at": self._progress_started_at,
                "completed_at": datetime.now(timezone.utc).isoformat(),
                "duration_seconds": duration,
                "total_files": len(reparse_files),
                "processed_files": len(reparse_files),
                "failed_files": len(parse_failures),
                "current_file": None,
                "changed_files": changed_files,
                "deleted_files": deleted_files,
                "affected_neighbor_files": affected_neighbor_files,
                "parser_stats": parser_stats,
                "unresolved_symbols": unresolved_symbols,
                "node_count": node_count,
                "edge_count": edge_count,
                "orphaned_edges": orphaned_edges,
                "warnings_count": len(warnings),
            },
            force=True,
        )
        return summary

    async def watch_refresh(
        self,
        export_dir: str,
        duration_seconds: int = 60,
        poll_interval: float = 1.0,
        debounce_seconds: float = 2.0,
        max_refreshes: int = 25,
    ) -> dict[str, Any]:
        """Poll for file changes and trigger incremental refresh with debounce."""
        export_dir = self._activate_scope(export_dir)
        started = time.monotonic()
        refreshes: list[dict[str, Any]] = []
        last_seen_change_fingerprint: str | None = None

        while (time.monotonic() - started) < duration_seconds and len(refreshes) < max_refreshes:
            current_files = await self._discover_file_records(Path(export_dir))
            delta = await self._manifest.get_delta(current_files)
            has_change = bool(delta["new"] or delta["changed"] or delta["deleted"])
            if has_change:
                change_fingerprint = json.dumps(
                    {
                        "new": sorted(delta["new"]),
                        "changed": sorted(delta["changed"]),
                        "deleted": sorted(delta["deleted"]),
                    },
                    sort_keys=True,
                )
                if change_fingerprint == last_seen_change_fingerprint:
                    await asyncio.sleep(poll_interval)
                    continue
                last_seen_change_fingerprint = change_fingerprint
                await asyncio.sleep(debounce_seconds)
                summary = await self.refresh(export_dir)
                refreshes.append(summary.model_dump())
                continue
            await asyncio.sleep(poll_interval)

        return {
            "duration_seconds": round(time.monotonic() - started, 3),
            "refresh_count": len(refreshes),
            "refreshes": refreshes,
        }

    async def _discover_file_records(
        self,
        export_path: Path,
        *,
        run_id: str | None = None,
        mode: str = "full_ingest",
    ) -> dict[str, dict[str, int | str]]:
        """Discover ingestion targets and reuse stored hashes when file stats match."""
        files: dict[str, dict[str, int | str]] = {}
        root = export_path.resolve()
        tracked = await self._manifest.get_tracked_files()
        scanned_files = 0
        hashed_files = 0
        reused_hashes = 0
        for discovery_root in self._discovery_roots(root):
            for current_root, dirs, filenames in os.walk(discovery_root, topdown=True):
                self._raise_if_cancelled()
                current_path = Path(current_root)
                dirs[:] = [d for d in dirs if d not in self.SKIP_DIR_NAMES]

                # Skip nested repositories entirely. Export roots are allowed to be repos,
                # but cloned repos inside the export tree should not be indexed.
                if current_path != discovery_root and any((current_path / marker).exists() for marker in (".git", ".hg", ".svn")):
                    dirs[:] = []
                    continue

                for filename in sorted(filenames):
                    self._raise_if_cancelled()
                    path = current_path / filename
                    scanned_files += 1
                    if self._should_skip_file(path):
                        continue
                    if not self._matches_discovery_rules(path, root):
                        continue
                    if path.suffix == ".json":
                        if not is_vlocity_datapack_file(path):
                            continue
                    elif not any(
                        path.name.endswith(sfx)
                        for sfx in (
                            ".cls",
                            ".trigger",
                            ".js",
                            ".html",
                            ".object-meta.xml",
                            ".flow-meta.xml",
                            ".labels-meta.xml",
                            ".label-meta.xml",
                            ".globalValueSet-meta.xml",
                            ".md-meta.xml",
                        )
                    ):
                        continue
                    stat = path.stat()
                    tracked_file = tracked.get(str(path))
                    sha = None
                    if self._stat_fingerprint_matches(tracked_file, stat):
                        sha = str(tracked_file["sha256"])
                        reused_hashes += 1
                    else:
                        sha = compute_sha256(str(path))
                        hashed_files += 1
                    files[str(path)] = {
                        "sha256": sha,
                        "size_bytes": stat.st_size,
                        "mtime_ns": stat.st_mtime_ns,
                        "ctime_ns": getattr(stat, "st_ctime_ns", None),
                    }
                    if run_id:
                        self._write_progress_snapshot(
                            {
                                "run_id": run_id,
                                "mode": mode,
                                "state": "running",
                                "phase": "discovering",
                                "export_dir": str(root),
                                "project_scope": self._active_project_scope,
                                "started_at": self._progress_started_at,
                                "total_files": max(scanned_files, 1),
                                "processed_files": hashed_files + reused_hashes,
                                "failed_files": 0,
                                "current_file": str(path),
                                "current_parser": "discovery",
                                "parser_stats": self._empty_parser_stats(),
                                "unresolved_symbols": 0,
                                "warnings_count": 0,
                                "discovery_scanned_files": scanned_files,
                                "discovery_discovered_files": len(files),
                                "discovery_hashed_files": hashed_files,
                                "discovery_reused_hashes": reused_hashes,
                            }
                        )
        return files

    def _discover_files(self, export_path: Path) -> dict[str, str]:
        """Compatibility helper used by tests; returns path->sha mapping."""
        records = asyncio.run(self._discover_file_records(export_path))
        return {path: str(meta["sha256"]) for path, meta in records.items()}

    def _discovery_roots(self, export_path: Path) -> list[Path]:
        root = export_path.resolve()
        if self._include_globs:
            return [root]
        if root.name in self.DEFAULT_DISCOVERY_ROOTS:
            return [root]
        discovered: list[Path] = []
        seen: set[str] = set()

        def _add(candidate: Path) -> None:
            resolved = candidate.resolve()
            key = str(resolved)
            if not resolved.exists() or not resolved.is_dir() or key in seen:
                return
            seen.add(key)
            discovered.append(resolved)

        for package_dir in self._sfdx_package_directories(root):
            _add(package_dir)
        for child in sorted(root.iterdir()):
            if child.is_dir() and child.name in self.DEFAULT_DISCOVERY_ROOTS:
                _add(child)
        return discovered or [root]

    @staticmethod
    def _sfdx_package_directories(root: Path) -> list[Path]:
        config_path = root / "sfdx-project.json"
        if not config_path.exists():
            return []
        try:
            payload = json.loads(config_path.read_text(encoding="utf-8"))
        except Exception:
            return []
        package_dirs = payload.get("packageDirectories")
        if not isinstance(package_dirs, list):
            return []
        discovered: list[Path] = []
        seen: set[str] = set()
        for entry in package_dirs:
            if not isinstance(entry, dict):
                continue
            rel_path = entry.get("path")
            if not isinstance(rel_path, str) or not rel_path.strip():
                continue
            candidate = (root / rel_path).expanduser()
            resolved = candidate.resolve()
            key = str(resolved)
            if key in seen or not resolved.exists() or not resolved.is_dir():
                continue
            seen.add(key)
            discovered.append(resolved)
        return discovered

    @classmethod
    def _should_skip_file(cls, path: Path) -> bool:
        name = path.name
        if any(name.startswith(prefix) or prefix in name for prefix in cls.SKIP_FILE_PREFIXES):
            return True
        if any(name.endswith(suffix) for suffix in cls.SKIP_FILE_SUFFIXES):
            return True
        return False

    def _matches_discovery_rules(self, path: Path, root: Path) -> bool:
        relative = path.relative_to(root).as_posix()
        if self._include_globs and not any(fnmatch.fnmatch(relative, pattern) for pattern in self._include_globs):
            return False
        if self._exclude_globs and any(fnmatch.fnmatch(relative, pattern) for pattern in self._exclude_globs):
            return False
        return True

    @staticmethod
    def _empty_parser_stats() -> dict[str, dict[str, int]]:
        return {
            "apex": {"parsed_files": 0, "error_files": 0, "skipped_files": 0},
            "flow": {"parsed_files": 0, "error_files": 0, "skipped_files": 0},
            "object": {"parsed_files": 0, "error_files": 0, "skipped_files": 0},
            "labels": {"parsed_files": 0, "error_files": 0, "skipped_files": 0},
            "lwc": {"parsed_files": 0, "error_files": 0, "skipped_files": 0},
            "vlocity": {
                "parsed_files": 0,
                "error_files": 0,
                "skipped_files": 0,
                "specialized_files": 0,
                "generic_files": 0,
                "invalid_json_files": 0,
                "non_object_json_files": 0,
                "non_datapack_json_files": 0,
                "unsupported_type_files": 0,
            },
            "unknown": {"parsed_files": 0, "error_files": 0, "skipped_files": 0},
        }

    @staticmethod
    def _record_parser_outcome(
        parser_stats: dict[str, dict[str, int]],
        parser_name: str,
        file_nodes: list[NodeFact],
        file_edges: list[EdgeFact],
        metadata: dict[str, Any] | None = None,
    ) -> None:
        bucket = parser_stats[parser_name]
        metadata = metadata or {}
        if parser_name != "vlocity":
            if file_nodes or file_edges:
                bucket["parsed_files"] += 1
            else:
                bucket["skipped_files"] += 1
            return

        outcome = str(metadata.get("outcome") or "")
        if outcome == "parsed_specialized":
            bucket["parsed_files"] += 1
            bucket["specialized_files"] += 1
            return
        if outcome == "parsed_generic":
            bucket["parsed_files"] += 1
            bucket["generic_files"] += 1
            if bool(metadata.get("unsupported_type")):
                bucket["unsupported_type_files"] += 1
            return
        if outcome == "invalid_json":
            bucket["skipped_files"] += 1
            bucket["invalid_json_files"] += 1
            return
        if outcome == "non_object_json":
            bucket["skipped_files"] += 1
            bucket["non_object_json_files"] += 1
            return
        if outcome == "non_datapack_json":
            bucket["skipped_files"] += 1
            bucket["non_datapack_json_files"] += 1
            return

        if file_nodes or file_edges:
            bucket["parsed_files"] += 1
        else:
            bucket["skipped_files"] += 1

    @staticmethod
    def _parser_name_for_file(fpath: str) -> str:
        path = Path(fpath)
        if path.suffix in {".cls", ".trigger"}:
            return "apex"
        if path.suffix in {".js", ".html"} and "lwc" in {part.lower() for part in path.parts}:
            return "lwc"
        if fpath.endswith(".flow-meta.xml"):
            return "flow"
        if fpath.endswith(".object-meta.xml"):
            return "object"
        if fpath.endswith(".globalValueSet-meta.xml"):
            return "object"
        if fpath.endswith(".md-meta.xml"):
            return "object"
        if fpath.endswith(".labels-meta.xml") or fpath.endswith(".label-meta.xml"):
            return "labels"
        if path.suffix == ".json" and is_vlocity_datapack_file(path):
            return "vlocity"
        return "unknown"

    @staticmethod
    def _is_unresolved_dynamic_edge(edge: EdgeFact) -> bool:
        if edge.dst_qualified_name.startswith("UNRESOLVED."):
            return True
        if edge.src_qualified_name.startswith("UNRESOLVED."):
            return True
        if edge.resolutionMethod.lower() in {"dynamic", "unknown", "traced_limit", "regex"}:
            return True
        return False

    async def _collect_facts(
        self,
        files: list[str],
        *,
        file_records: dict[str, dict[str, int | str]] | None = None,
        run_id: str | None = None,
        mode: str = "full_ingest",
        total_files: int | None = None,
        changed_files: list[str] | None = None,
        deleted_files: list[str] | None = None,
        affected_neighbor_files: list[str] | None = None,
    ) -> tuple[dict[str, list[NodeFact]], list[EdgeFact], list[str], dict[str, dict[str, int]], int]:
        facts_by_type: dict[str, list[NodeFact]] = defaultdict(list)
        all_edges: list[EdgeFact] = []
        parse_failures: list[str] = []
        parser_stats = self._empty_parser_stats()
        unresolved_symbols = 0

        total = len(files) if total_files is None else total_files
        for index, fpath in enumerate(files, start=1):
            self._raise_if_cancelled()
            parser_name = self._parser_name_for_file(fpath)
            try:
                file_sha = None
                if file_records and fpath in file_records:
                    file_sha = str(file_records[fpath].get("sha256") or "")
                file_nodes, file_edges, parse_metadata = await self._parse_file_with_metadata(fpath, sha256=file_sha or None)
            except Exception as exc:  # noqa: BLE001
                logger.warning("Parse failure for %s: %s", fpath, exc)
                parse_failures.append(fpath)
                await self._manifest.set_status(fpath, "FAILED")
                parser_stats[parser_name]["error_files"] += 1
                if run_id:
                    self._write_progress_snapshot(
                        {
                            "run_id": run_id,
                            "mode": mode,
                            "state": "running",
                            "phase": "parsing",
                            "export_dir": str(self._active_export_root) if self._active_export_root else None,
                            "project_scope": self._active_project_scope,
                            "started_at": self._progress_started_at,
                            "total_files": total,
                            "processed_files": index,
                            "failed_files": len(parse_failures),
                            "current_file": fpath,
                            "current_parser": parser_name,
                            "changed_files": changed_files or [],
                            "deleted_files": deleted_files or [],
                            "affected_neighbor_files": affected_neighbor_files or [],
                            "parser_stats": parser_stats,
                            "unresolved_symbols": unresolved_symbols,
                            "warnings_count": 0,
                            "cache_enabled": bool(self._parse_cache),
                        }
                    )
                continue

            self._record_parser_outcome(parser_stats, parser_name, file_nodes, file_edges, parse_metadata)

            for node_fact in file_nodes:
                facts_by_type[node_fact.label].append(node_fact)
            for edge in file_edges:
                if self._is_unresolved_dynamic_edge(edge):
                    unresolved_symbols += 1
            all_edges.extend(file_edges)
            if run_id:
                self._write_progress_snapshot(
                    {
                        "run_id": run_id,
                        "mode": mode,
                        "state": "running",
                        "phase": "parsing",
                        "export_dir": str(self._active_export_root) if self._active_export_root else None,
                        "project_scope": self._active_project_scope,
                        "started_at": self._progress_started_at,
                        "total_files": total,
                        "processed_files": index,
                        "failed_files": len(parse_failures),
                        "current_file": fpath,
                        "current_parser": parser_name,
                        "changed_files": changed_files or [],
                        "deleted_files": deleted_files or [],
                        "affected_neighbor_files": affected_neighbor_files or [],
                        "parser_stats": parser_stats,
                        "unresolved_symbols": unresolved_symbols,
                        "warnings_count": 0,
                        "cache_enabled": bool(self._parse_cache),
                    }
                )

        return facts_by_type, all_edges, parse_failures, parser_stats, unresolved_symbols

    def _write_progress_snapshot(self, payload: dict[str, Any], *, force: bool = False) -> None:
        now = datetime.now(timezone.utc).isoformat()
        payload = dict(payload)
        phase = payload.get("phase")
        if phase is not None:
            try:
                IngestionPhase(str(phase))
            except ValueError as exc:
                raise ValueError(f"Invalid ingestion phase: {phase!r}") from exc
        payload.setdefault("updated_at", now)
        payload.setdefault("last_progress_at", now)
        payload.setdefault("last_job_heartbeat_at", now)
        payload.setdefault("started_at", self._progress_started_at)

        total_files = payload.get("total_files")
        processed_files = payload.get("processed_files")
        if isinstance(total_files, int) and total_files >= 0 and isinstance(processed_files, int):
            payload["completion_ratio"] = 1.0 if total_files == 0 else round(min(processed_files / total_files, 1.0), 4)
            payload["pending_files"] = max(total_files - processed_files, 0)
            payload["queue_status"] = {
                "pending": payload["pending_files"],
                "processed": processed_files,
                "failed": int(payload.get("failed_files", 0) or 0),
            }
        started_at = payload.get("started_at")
        if isinstance(started_at, str):
            try:
                started_dt = datetime.fromisoformat(started_at)
                elapsed_seconds = max((datetime.now(timezone.utc) - started_dt).total_seconds(), 0.0)
                payload["elapsed_seconds"] = round(elapsed_seconds, 3)
                if isinstance(processed_files, int) and elapsed_seconds > 0:
                    files_per_second = processed_files / elapsed_seconds
                    payload["files_per_second"] = round(files_per_second, 3)
                    pending_files = payload.get("pending_files")
                    if isinstance(pending_files, int) and files_per_second > 0:
                        payload["estimated_remaining_seconds"] = round(pending_files / files_per_second, 1)
            except Exception:
                pass

        monotonic_now = time.monotonic()
        if not force and (monotonic_now - self._last_progress_flush_at) < 0.25:
            return

        out = Path(self._ingestion_progress_path)
        out.parent.mkdir(parents=True, exist_ok=True)
        out.write_text(json.dumps(payload, indent=2), encoding="utf-8")
        self._last_progress_flush_at = monotonic_now

    async def _load_scoped_nodes_with_props(self) -> dict[str, list[tuple[str, dict[str, Any]]]]:
        rows_by_label: dict[str, list[tuple[str, dict[str, Any]]]] = {}
        labels = await self._graph.get_labels()
        for label in labels:
            try:
                rows = await self._graph.query(f'SELECT qualified_name, props FROM "{label}"')
            except Exception:
                rows = []
            kept: list[tuple[str, dict[str, Any]]] = []
            for row in rows:
                qn = str(row.get("qualified_name", ""))
                if not qn:
                    continue
                props = parse_json_props(row.get("props"))
                if self._belongs_to_active_scope(qn, props):
                    kept.append((qn, props))
            rows_by_label[label] = kept
        return rows_by_label

    async def _write_nodes(self, facts_by_type: dict[str, list[NodeFact]]) -> tuple[dict[str, int], set[str]]:
        node_counts: dict[str, int] = defaultdict(int)
        written_qnames: set[str] = set()

        for label in NODE_WRITE_ORDER:
            self._raise_if_cancelled()
            for node_fact in facts_by_type.get(label, []):
                self._raise_if_cancelled()
                scoped_fact = self._scope_node_fact(node_fact)
                qname = scoped_fact.key_props.get("qualifiedName")
                if qname and qname in written_qnames:
                    continue
                merged_qname = await self._graph.merge_node(
                    scoped_fact.label,
                    scoped_fact.key_props,
                    scoped_fact.all_props,
                )
                actual_qname = qname or merged_qname
                if actual_qname:
                    written_qnames.add(actual_qname)
                    vector_props = dict(scoped_fact.all_props)
                    vector_props.setdefault("label", scoped_fact.label)
                    await self._upsert_vector_for_node(actual_qname, vector_props)
                node_counts[scoped_fact.label] += 1

        known_labels = set(NODE_WRITE_ORDER)
        for label, node_facts in facts_by_type.items():
            self._raise_if_cancelled()
            if label in known_labels:
                continue
            for node_fact in node_facts:
                self._raise_if_cancelled()
                scoped_fact = self._scope_node_fact(node_fact)
                qname = scoped_fact.key_props.get("qualifiedName")
                if qname and qname in written_qnames:
                    continue
                merged_qname = await self._graph.merge_node(
                    scoped_fact.label,
                    scoped_fact.key_props,
                    scoped_fact.all_props,
                )
                actual_qname = qname or merged_qname
                if actual_qname:
                    written_qnames.add(actual_qname)
                    vector_props = dict(scoped_fact.all_props)
                    vector_props.setdefault("label", scoped_fact.label)
                    await self._upsert_vector_for_node(actual_qname, vector_props)
                node_counts[scoped_fact.label] += 1

        return dict(node_counts), written_qnames

    async def _load_node_registry(self) -> dict[str, str]:
        registry: dict[str, str] = {}
        labels = await self._graph.get_labels()
        for label in labels:
            self._raise_if_cancelled()
            try:
                rows = await self._graph.query(f'SELECT qualified_name, props FROM "{label}"')
            except Exception:
                rows = []
            for row in rows:
                qn = str(row.get("qualified_name", ""))
                if not qn:
                    continue
                props = parse_json_props(row.get("props"))
                if self._belongs_to_active_scope(qn, props):
                    registry[qn] = label
        return registry

    async def _nodes_for_source_files(self, source_files: list[str]) -> set[str]:
        if not source_files:
            return set()
        labels = await self._graph.get_labels()
        source_set = set(source_files)
        matched: set[str] = set()
        for label in labels:
            self._raise_if_cancelled()
            try:
                rows = await self._graph.query(f'SELECT qualified_name, props FROM "{label}"')
            except Exception:
                rows = []
            for row in rows:
                qn = str(row.get("qualified_name", ""))
                if not qn:
                    continue
                props = parse_json_props(row.get("props"))
                if not self._belongs_to_active_scope(qn, props):
                    continue
                if props.get("sourceFile") in source_set:
                    matched.add(qn)
        return matched

    async def _collect_neighbor_nodes(self, node_qnames: set[str], limit: int = 1500) -> set[str]:
        if not node_qnames:
            return set()
        rel_types = await self._graph.get_relationship_types()
        neighbors: set[str] = set()
        for rel in rel_types:
            self._raise_if_cancelled()
            try:
                rows = await self._graph.query(
                    f'SELECT src_qualified_name, dst_qualified_name FROM "{rel}"'
                )
            except Exception:
                rows = []
            for row in rows:
                src = str(row.get("src_qualified_name", ""))
                dst = str(row.get("dst_qualified_name", ""))
                if not src or not dst:
                    continue
                if self._active_project_scope:
                    scope_prefix = f"{self._active_project_scope}::"
                    if not src.startswith(scope_prefix) or not dst.startswith(scope_prefix):
                        continue
                if src in node_qnames and dst not in node_qnames:
                    neighbors.add(dst)
                elif dst in node_qnames and src not in node_qnames:
                    neighbors.add(src)
                if len(neighbors) >= limit:
                    return neighbors
        return neighbors

    async def _source_files_for_nodes(self, node_qnames: set[str]) -> set[str]:
        if not node_qnames:
            return set()
        labels = await self._graph.get_labels()
        files: set[str] = set()
        qn_set = set(node_qnames)
        for label in labels:
            self._raise_if_cancelled()
            try:
                rows = await self._graph.query(f'SELECT qualified_name, props FROM "{label}"')
            except Exception:
                rows = []
            for row in rows:
                qn = str(row.get("qualified_name", ""))
                if qn not in qn_set:
                    continue
                props = parse_json_props(row.get("props"))
                if not self._belongs_to_active_scope(qn, props):
                    continue
                source = props.get("sourceFile")
                if isinstance(source, str) and source:
                    files.add(source)
        return files

    async def _purge_nodes_by_source_files(self, source_files: list[str]) -> set[str]:
        if not source_files:
            return set()

        labels = await self._graph.get_labels()
        source_set = set(source_files)
        removed_qnames: set[str] = set()

        for label in labels:
            self._raise_if_cancelled()
            try:
                rows = await self._graph.query(f'SELECT qualified_name, props FROM "{label}"')
            except Exception:
                continue
            to_delete: list[str] = []
            for row in rows:
                qn = str(row.get("qualified_name", ""))
                props = parse_json_props(row.get("props"))
                source = props.get("sourceFile")
                if qn and source in source_set and self._belongs_to_active_scope(qn, props):
                    to_delete.append(qn)
            for qn in to_delete:
                self._raise_if_cancelled()
                try:
                    await self._graph.query(
                        f'DELETE FROM "{label}" WHERE qualified_name = $qn',
                        {"qn": qn},
                    )
                    removed_qnames.add(qn)
                except Exception:
                    continue

        return removed_qnames

    async def _delete_edges_for_nodes(self, node_qnames: set[str]) -> None:
        if not node_qnames:
            return
        rel_types = await self._graph.get_relationship_types()
        for rel in rel_types:
            self._raise_if_cancelled()
            for qn in node_qnames:
                self._raise_if_cancelled()
                try:
                    await self._graph.query(
                        f'DELETE FROM "{rel}" WHERE src_qualified_name = $qn OR dst_qualified_name = $qn',
                        {"qn": qn},
                    )
                except Exception:
                    continue

    async def _prune_dangling_edges(self) -> None:
        registry = await self._load_node_registry()
        rel_types = await self._graph.get_relationship_types()

        for rel in rel_types:
            self._raise_if_cancelled()
            try:
                rows = await self._graph.query(
                    f'SELECT src_qualified_name, dst_qualified_name FROM "{rel}"'
                )
            except Exception:
                continue
            for row in rows:
                self._raise_if_cancelled()
                src = str(row.get("src_qualified_name", ""))
                dst = str(row.get("dst_qualified_name", ""))
                if not src or not dst:
                    continue
                if self._active_project_scope:
                    in_scope_prefix = f"{self._active_project_scope}::"
                    if not src.startswith(in_scope_prefix) and not dst.startswith(in_scope_prefix):
                        continue
                if src in registry and dst in registry:
                    continue
                try:
                    await self._graph.query(
                        f'DELETE FROM "{rel}" WHERE src_qualified_name = $src AND dst_qualified_name = $dst',
                        {"src": src, "dst": dst},
                    )
                except Exception:
                    continue

    async def _write_edges(
        self,
        edge_facts: list[EdgeFact],
        node_registry: dict[str, str],
    ) -> tuple[int, int, list[str]]:
        edge_count = 0
        orphaned_edges = 0
        warnings: list[str] = []

        for edge_fact in edge_facts:
            self._raise_if_cancelled()
            src_known = edge_fact.src_qualified_name in node_registry
            dst_known = edge_fact.dst_qualified_name in node_registry

            if not dst_known:
                stub_label = edge_fact.dst_label or "ExternalNamespace"
                if stub_label == "Unknown":
                    stub_label = "ExternalNamespace"
                if stub_label not in NODE_WRITE_ORDER and stub_label not in {
                    "ExternalNamespace",
                    "CustomLabel",
                    "Flow",
                    "PlatformEvent",
                    "SFObject",
                    "SFField",
                    "SFPicklistValue",
                    "ApexClass",
                    "CustomSetting",
                    "CustomMetadataType",
                    "GlobalValueSet",
                }:
                    stub_label = "ExternalNamespace"
                await self._graph.merge_node(
                    stub_label,
                    {"qualifiedName": edge_fact.dst_qualified_name},
                    self._stub_node_props(edge_fact.dst_qualified_name, stub_label),
                )
                node_registry[edge_fact.dst_qualified_name] = stub_label
                dst_known = True

            if not src_known or not dst_known:
                orphaned_edges += 1
                warnings.append(
                    f"Orphaned edge: {edge_fact.src_qualified_name} -[{edge_fact.rel_type}]-> {edge_fact.dst_qualified_name}"
                )
                continue

            edge_props = edge_fact.to_merge_props()
            if self._active_project_scope:
                edge_props["projectScope"] = self._active_project_scope
            await self._graph.merge_edge(
                edge_fact.src_qualified_name,
                edge_fact.src_label,
                edge_fact.rel_type,
                edge_fact.dst_qualified_name,
                edge_fact.dst_label,
                edge_props,
            )
            edge_count += 1

        return edge_count, orphaned_edges, warnings

    async def _parse_file(self, fpath: str, *, sha256: str | None = None) -> tuple[list[NodeFact], list[EdgeFact]]:
        nodes, edges, _ = await self._parse_file_with_metadata(fpath, sha256=sha256)
        return nodes, edges

    async def _parse_file_with_metadata(
        self,
        fpath: str,
        *,
        sha256: str | None = None,
    ) -> tuple[list[NodeFact], list[EdgeFact], dict[str, Any]]:
        path = Path(fpath)
        parser_name = self._parser_name_for_file(fpath)
        cache_namespace = self._parse_cache_namespace(parser_name, fpath)
        can_cache = self._cacheable_parser(parser_name)
        if self._parse_cache and sha256 and can_cache:
            cached = await self._parse_cache.get(cache_namespace, sha256)
            if cached is not None:
                nodes, edges, metadata = self._deserialize_parse_result(cached)
                return self._rebind_cached_nodes(nodes, fpath), edges, metadata

        if path.suffix in {".cls", ".trigger"}:
            result = await self._pool.parse(fpath, "apex")
            if not result.get("ok") and str(result.get("error", "")) in TRANSIENT_WORKER_ERRORS:
                # One retry for transient parser worker lifecycle events.
                await asyncio.sleep(0.05)
                result = await self._pool.parse(fpath, "apex")
            if not result.get("ok"):
                error = str(result.get("error") or "worker_parse_failed")
                payload = result.get("payload")
                detail_suffix = _format_parser_failure_details(payload)
                if detail_suffix:
                    raise RuntimeError(f"{error} | {detail_suffix}")
                raise RuntimeError(error)
            payload = result.get("payload") or {}
            nodes, edges = self._apex_extractor.extract(payload, fpath)

            # APEX-11 dynamic accessor edge candidates from raw method refs.
            primary_class = next((n.key_props.get("qualifiedName") for n in nodes if n.label == "ApexClass"), path.stem)
            for ref in payload.get("potential_refs", []):
                if ref.get("refType") != "CALLS_CLASS_METHOD":
                    continue
                target_class = ref.get("targetClass", "")
                target_method = ref.get("method", "")
                if not target_class or not target_method:
                    continue
                edges.extend(
                    self._dynamic_registry.match(
                        class_name=target_class,
                        method_name=target_method,
                        src_qualified_name=primary_class,
                        src_label="ApexClass",
                        context_snippet=ref.get("contextSnippet", ""),
                    )
                )

            metadata = {"outcome": "parsed", "parser_strategy": "specialized", "node_label": "ApexClass"}
            if self._parse_cache and sha256 and can_cache:
                await self._parse_cache.put(cache_namespace, sha256, self._serialize_parse_result(nodes, edges, metadata))
            return nodes, edges, metadata

        if path.suffix in {".js", ".html"} and "lwc" in {part.lower() for part in path.parts}:
            nodes, edges = parse_lwc_file(fpath)
            if self._parse_cache and sha256 and can_cache:
                await self._parse_cache.put(cache_namespace, sha256, self._serialize_parse_result(nodes, edges, {"outcome": "parsed"}))
            return nodes, edges, {"outcome": "parsed"}

        if fpath.endswith(".flow-meta.xml"):
            nodes, edges = parse_flow_xml(fpath)
            if self._parse_cache and sha256 and can_cache:
                await self._parse_cache.put(cache_namespace, sha256, self._serialize_parse_result(nodes, edges, {"outcome": "parsed"}))
            return nodes, edges, {"outcome": "parsed"}

        if fpath.endswith(".object-meta.xml"):
            nodes, edges = parse_object_dir(str(path.parent))
            if self._parse_cache and sha256 and can_cache:
                await self._parse_cache.put(cache_namespace, sha256, self._serialize_parse_result(nodes, edges, {"outcome": "parsed"}))
            return nodes, edges, {"outcome": "parsed"}

        if fpath.endswith(".globalValueSet-meta.xml"):
            nodes, edges = parse_global_value_set_xml(fpath)
            if self._parse_cache and sha256 and can_cache:
                await self._parse_cache.put(cache_namespace, sha256, self._serialize_parse_result(nodes, edges, {"outcome": "parsed"}))
            return nodes, edges, {"outcome": "parsed"}

        if fpath.endswith(".md-meta.xml"):
            nodes, edges = parse_custom_metadata_record_xml(fpath)
            if self._parse_cache and sha256 and can_cache:
                await self._parse_cache.put(cache_namespace, sha256, self._serialize_parse_result(nodes, edges, {"outcome": "parsed"}))
            return nodes, edges, {"outcome": "parsed"}

        if fpath.endswith(".labels-meta.xml") or fpath.endswith(".label-meta.xml"):
            nodes, edges = parse_labels_xml(fpath)
            if self._parse_cache and sha256 and can_cache:
                await self._parse_cache.put(cache_namespace, sha256, self._serialize_parse_result(nodes, edges, {"outcome": "parsed"}))
            return nodes, edges, {"outcome": "parsed"}

        if path.suffix == ".json" and is_vlocity_datapack_file(path):
            nodes, edges, meta = parse_vlocity_json_detailed(fpath)
            metadata = {
                "outcome": meta.outcome,
                "pack_type": meta.pack_type,
                "parser_strategy": meta.parser_strategy,
                "node_label": meta.node_label,
                "unsupported_type": meta.unsupported_type,
            }
            if self._parse_cache and sha256 and can_cache:
                await self._parse_cache.put(cache_namespace, sha256, self._serialize_parse_result(nodes, edges, metadata))
            return nodes, edges, metadata

        return [], [], {"outcome": "skipped"}

    def _apply_picklist_guard(
        self,
        edge_facts: list[EdgeFact],
        facts_by_type: dict[str, list[NodeFact]],
    ) -> list[EdgeFact]:
        """Resolve READS_VALUE candidates only when source field is known Picklist."""
        picklist_fields = {
            nf.key_props.get("qualifiedName", "")
            for nf in facts_by_type.get("SFField", [])
            if nf.all_props.get("dataType") == "Picklist"
            or nf.all_props.get("fieldType") == "Picklist"
        }

        resolved: list[EdgeFact] = []
        for edge in edge_facts:
            if edge.rel_type != "READS_VALUE" or not edge.dst_qualified_name.startswith("UNRESOLVED."):
                resolved.append(edge)
                continue

            parts = edge.dst_qualified_name.split(".")
            if len(parts) < 3:
                continue
            field_name = parts[1]
            comparand = ".".join(parts[2:])
            matched_field = next((qn for qn in picklist_fields if qn.endswith(f".{field_name}")), None)
            if not matched_field:
                continue

            resolved.append(
                edge.model_copy(
                    update={
                        "dst_qualified_name": f"{matched_field}.{comparand}",
                        "confidence": 0.9,
                        "resolutionMethod": "picklist_guard",
                    }
                )
            )

        return resolved

    def _write_ingestion_meta(self, summary: IngestionSummary) -> None:
        """Persist latest ingestion metadata for freshness contract responses."""
        project_scope = self._compute_project_scope(summary.export_dir)
        payload = {
            "run_id": summary.run_id,
            "indexed_at": datetime.now(timezone.utc).isoformat(),
            "indexed_commit": self._current_git_commit(),
            "export_dir": summary.export_dir,
            "project_scope": project_scope,
            "total_nodes": summary.total_nodes,
            "edge_count": summary.edge_count,
            "orphaned_edges": summary.orphaned_edges,
            "parse_failures": len(summary.parse_failures),
            "warnings": len(summary.warnings),
            "mode": "full_ingest",
            "parser_stats": summary.parser_stats,
            "unresolved_symbols": summary.unresolved_symbols,
        }
        out = Path(self._ingestion_meta_path)
        out.parent.mkdir(parents=True, exist_ok=True)
        out.write_text(json.dumps(payload, indent=2), encoding="utf-8")

    def _write_refresh_meta(self, summary: RefreshSummary) -> None:
        project_scope = self._compute_project_scope(summary.export_dir)
        payload = {
            "run_id": summary.run_id,
            "indexed_at": datetime.now(timezone.utc).isoformat(),
            "indexed_commit": self._current_git_commit(),
            "export_dir": summary.export_dir,
            "project_scope": project_scope,
            "processed_files": summary.processed_files,
            "changed_files": summary.changed_files,
            "deleted_files": summary.deleted_files,
            "affected_neighbor_files": summary.affected_neighbor_files,
            "node_count": summary.node_count,
            "edge_count": summary.edge_count,
            "orphaned_edges": summary.orphaned_edges,
            "warnings": len(summary.warnings),
            "mode": "incremental_refresh",
            "parser_stats": summary.parser_stats,
            "unresolved_symbols": summary.unresolved_symbols,
        }
        out = Path(self._ingestion_meta_path)
        out.parent.mkdir(parents=True, exist_ok=True)
        out.write_text(json.dumps(payload, indent=2), encoding="utf-8")

    @staticmethod
    def _current_git_commit() -> str | None:
        try:
            root = Path(__file__).resolve().parents[3]
            result = subprocess.run(
                ["git", "rev-parse", "HEAD"],
                cwd=str(root),
                check=True,
                capture_output=True,
                text=True,
            )
            return result.stdout.strip()
        except Exception:
            return None
