#!/usr/bin/env python3
"""Quality gate: compare sfgraph exact evidence vs native code search hits."""
from __future__ import annotations

import argparse
import asyncio
import json
import statistics
import subprocess
import time
from pathlib import Path
from typing import Any

from sfgraph.query.graph_query_service import GraphQueryService
from sfgraph.storage.duckpgq_store import DuckPGQStore
from sfgraph.storage.manifest_store import ManifestStore
from sfgraph.storage.vector_store import VectorStore


CASES: list[dict[str, str]] = [
    {
        "id": "status_populated",
        "question": "where is Status__c populated?",
        "token": "Status__c",
        "file_hint": "AccountService.cls",
    },
    {
        "id": "component_token_population",
        "question": "In class AccountService, where is Status__c populated? show method and source file.",
        "token": "Status__c",
        "file_hint": "AccountService.cls",
    },
]


def _native_search(repo_root: Path, token: str) -> tuple[int, float]:
    started = time.perf_counter()
    proc = subprocess.run(
        ["rg", "-n", token, str(repo_root)],
        capture_output=True,
        text=True,
        check=False,
    )
    elapsed_ms = (time.perf_counter() - started) * 1000.0
    if proc.returncode not in (0, 1):
        raise RuntimeError(proc.stderr.strip() or f"rg failed with code {proc.returncode}")
    hits = 0 if proc.returncode == 1 else sum(1 for line in proc.stdout.splitlines() if line.strip())
    return hits, elapsed_ms


def _has_exact_evidence(payload: dict[str, Any], *, file_hint: str) -> bool:
    for item in payload.get("evidence", []):
        if str(item.get("source", "")).lower() != "exact":
            continue
        file_path = str(item.get("file", ""))
        if file_hint and file_hint not in file_path:
            continue
        return True
    return False


async def _run(args: argparse.Namespace) -> int:
    repo_root = Path(args.repo_root).expanduser().resolve()
    data_dir = Path(args.data_dir).expanduser().resolve()
    graph = DuckPGQStore(db_path=str(data_dir / "sfgraph.duckdb"))
    manifest = ManifestStore(db_path=str(data_dir / "manifest.sqlite"))
    vectors = VectorStore(path=str(data_dir / "vectors"))
    await manifest.initialize()
    await vectors.initialize()
    try:
        service = GraphQueryService(
            graph=graph,
            manifest=manifest,
            vectors=vectors,
            repo_root=str(repo_root),
            ingestion_meta_path=str(data_dir / "ingestion_meta.json"),
            ingestion_progress_path=str(data_dir / "ingestion_progress.json"),
        )
        results: list[dict[str, Any]] = []
        failures: list[str] = []
        sfgraph_latencies: list[float] = []
        native_latencies: list[float] = []

        for case in CASES:
            started = time.perf_counter()
            payload = await service.analyze(
                question=case["question"],
                mode="auto",
                strict=True,
                max_results=50,
            )
            sfgraph_ms = (time.perf_counter() - started) * 1000.0
            sfgraph_latencies.append(sfgraph_ms)

            native_hits, native_ms = _native_search(repo_root, case["token"])
            native_latencies.append(native_ms)

            has_exact = _has_exact_evidence(payload, file_hint=case["file_hint"])
            if native_hits > 0 and not has_exact:
                failures.append(case["id"])

            results.append(
                {
                    "id": case["id"],
                    "question": case["question"],
                    "native_hits": native_hits,
                    "native_ms": round(native_ms, 2),
                    "sfgraph_ms": round(sfgraph_ms, 2),
                    "sfgraph_routed_to": payload.get("routed_to"),
                    "sfgraph_has_exact_evidence": has_exact,
                }
            )

        summary = {
            "total_cases": len(results),
            "failed_cases": failures,
            "sfgraph_median_ms": round(statistics.median(sfgraph_latencies), 2) if sfgraph_latencies else 0.0,
            "native_median_ms": round(statistics.median(native_latencies), 2) if native_latencies else 0.0,
            "pass": not failures,
        }
        print(json.dumps({"summary": summary, "cases": results}, indent=2))
        return 0 if not failures else 1
    finally:
        await graph.close()
        await manifest.close()


def main() -> int:
    parser = argparse.ArgumentParser(description="Compare sfgraph exact evidence against native ripgrep results.")
    parser.add_argument("--repo-root", required=True)
    parser.add_argument("--data-dir", required=True)
    args = parser.parse_args()
    return asyncio.run(_run(args))


if __name__ == "__main__":
    raise SystemExit(main())
