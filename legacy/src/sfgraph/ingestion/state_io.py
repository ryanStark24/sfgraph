"""Helpers for ingestion progress and metadata persistence."""
from __future__ import annotations

import json
import subprocess
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from sfgraph.ingestion.diagnostics import IngestionDiagnosticsReporter
from sfgraph.ingestion.models import IngestionPhase, IngestionState, IngestionSummary, RefreshSummary


def build_progress_payload(
    *,
    run_id: str,
    mode: str,
    state: str,
    phase: str,
    total_files: int,
    processed_files: int,
    failed_files: int,
    active_export_root: Path | None,
    active_project_scope: str | None,
    progress_started_at: str | None,
    current_file: str | None = None,
    current_parser: str | None = None,
    export_dir: str | None = None,
    **extra: Any,
) -> dict[str, Any]:
    payload: dict[str, Any] = {
        "run_id": run_id,
        "mode": mode,
        "state": state,
        "phase": phase,
        "export_dir": export_dir if export_dir is not None else (str(active_export_root) if active_export_root else None),
        "project_scope": active_project_scope,
        "started_at": progress_started_at,
        "total_files": total_files,
        "processed_files": processed_files,
        "failed_files": failed_files,
        "current_file": current_file,
    }
    if current_parser is not None:
        payload["current_parser"] = current_parser
    payload.update(extra)
    return payload


def write_progress_snapshot(
    *,
    ingestion_progress_path: str,
    payload: dict[str, Any],
    progress_started_at: str | None,
    last_progress_flush_at: float,
    force: bool = False,
) -> float:
    now = datetime.now(timezone.utc).isoformat()
    snapshot = dict(payload)
    phase = snapshot.get("phase")
    if phase is not None:
        try:
            IngestionPhase(str(phase))
        except ValueError as exc:
            raise ValueError(f"Invalid ingestion phase: {phase!r}") from exc
    state = snapshot.get("state")
    if state is not None:
        try:
            IngestionState(str(state))
        except ValueError as exc:
            raise ValueError(f"Invalid ingestion state: {state!r}") from exc
    snapshot.setdefault("updated_at", now)
    snapshot.setdefault("last_progress_at", now)
    snapshot.setdefault("last_job_heartbeat_at", now)
    snapshot.setdefault("started_at", progress_started_at)

    total_files = snapshot.get("total_files")
    processed_files = snapshot.get("processed_files")
    if isinstance(total_files, int) and total_files >= 0 and isinstance(processed_files, int):
        snapshot["completion_ratio"] = 1.0 if total_files == 0 else round(min(processed_files / total_files, 1.0), 4)
        snapshot["pending_files"] = max(total_files - processed_files, 0)
        snapshot["queue_status"] = {
            "pending": snapshot["pending_files"],
            "processed": processed_files,
            "failed": int(snapshot.get("failed_files", 0) or 0),
        }
    started_at = snapshot.get("started_at")
    if isinstance(started_at, str):
        try:
            started_dt = datetime.fromisoformat(started_at)
            elapsed_seconds = max((datetime.now(timezone.utc) - started_dt).total_seconds(), 0.0)
            snapshot["elapsed_seconds"] = round(elapsed_seconds, 3)
            if isinstance(processed_files, int) and elapsed_seconds > 0:
                files_per_second = processed_files / elapsed_seconds
                snapshot["files_per_second"] = round(files_per_second, 3)
                pending_files = snapshot.get("pending_files")
                if isinstance(pending_files, int) and files_per_second > 0:
                    snapshot["estimated_remaining_seconds"] = round(pending_files / files_per_second, 1)
        except Exception:
            pass

    monotonic_now = time.monotonic()
    if not force and (monotonic_now - last_progress_flush_at) < 0.25:
        return last_progress_flush_at

    out = Path(ingestion_progress_path)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(snapshot, indent=2), encoding="utf-8")
    return monotonic_now


def current_git_commit() -> str | None:
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


def write_ingestion_meta(
    *,
    ingestion_meta_path: str,
    ingestion_progress_path: str,
    summary: IngestionSummary,
    status_snapshot: dict[str, Any],
    project_scope: str | None,
    org_enrichment: dict[str, Any],
    vlocity_standards: dict[str, Any],
) -> None:
    payload = {
        "run_id": summary.run_id,
        "indexed_at": datetime.now(timezone.utc).isoformat(),
        "indexed_commit": current_git_commit(),
        "export_dir": summary.export_dir,
        "project_scope": project_scope,
        "total_nodes": summary.total_nodes,
        "edge_count": summary.edge_count,
        "orphaned_edges": summary.orphaned_edges,
        "parse_failures": summary.parse_failures,
        "warnings": summary.warnings,
        "mode": "full_ingest",
        "parser_stats": summary.parser_stats,
        "unresolved_symbols": summary.unresolved_symbols,
        "org_enrichment": org_enrichment,
        "vlocity_standards": vlocity_standards,
        "node_counts_by_type": status_snapshot.get("node_counts_by_type", summary.node_counts_by_type),
        "edge_counts_by_type": status_snapshot.get("edge_counts_by_type", {}),
        "status_counts": status_snapshot.get("status_counts", {}),
        "latest_completed_run": status_snapshot.get("latest_completed_run"),
    }
    out = Path(ingestion_meta_path)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(payload, indent=2), encoding="utf-8")
    IngestionDiagnosticsReporter(
        ingestion_meta_path=ingestion_meta_path,
        ingestion_progress_path=ingestion_progress_path,
    ).export_markdown(context={"export_dir": summary.export_dir})


def write_refresh_meta(
    *,
    ingestion_meta_path: str,
    ingestion_progress_path: str,
    summary: RefreshSummary,
    status_snapshot: dict[str, Any],
    project_scope: str | None,
    org_enrichment: dict[str, Any],
    vlocity_standards: dict[str, Any],
) -> None:
    payload = {
        "run_id": summary.run_id,
        "indexed_at": datetime.now(timezone.utc).isoformat(),
        "indexed_commit": current_git_commit(),
        "export_dir": summary.export_dir,
        "project_scope": project_scope,
        "processed_files": summary.processed_files,
        "changed_files": summary.changed_files,
        "deleted_files": summary.deleted_files,
        "affected_neighbor_files": summary.affected_neighbor_files,
        "node_count": summary.node_count,
        "edge_count": summary.edge_count,
        "orphaned_edges": summary.orphaned_edges,
        "warnings": summary.warnings,
        "mode": "incremental_refresh",
        "parser_stats": summary.parser_stats,
        "unresolved_symbols": summary.unresolved_symbols,
        "org_enrichment": org_enrichment,
        "vlocity_standards": vlocity_standards,
        "node_counts_by_type": status_snapshot.get("node_counts_by_type", {}),
        "edge_counts_by_type": status_snapshot.get("edge_counts_by_type", {}),
        "status_counts": status_snapshot.get("status_counts", {}),
        "latest_completed_run": status_snapshot.get("latest_completed_run"),
    }
    out = Path(ingestion_meta_path)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(payload, indent=2), encoding="utf-8")
    IngestionDiagnosticsReporter(
        ingestion_meta_path=ingestion_meta_path,
        ingestion_progress_path=ingestion_progress_path,
    ).export_markdown(context={"export_dir": summary.export_dir})
