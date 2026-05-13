"""Benchmark utilities for ingest/query performance verification."""
from __future__ import annotations

import statistics
import time
from pathlib import Path
from typing import Any

from sfgraph.benchmark_synthetic import generate_synthetic_export
from sfgraph.ingestion.service import IngestionService
from sfgraph.parser.pool import NodeParserPool
from sfgraph.query.graph_query_service import GraphQueryService
from sfgraph.storage.duckpgq_store import DuckPGQStore
from sfgraph.storage.manifest_store import ManifestStore
from sfgraph.storage.vector_store import VectorStore


async def run_benchmark(
    export_dir: str,
    query_samples: list[str] | None = None,
    query_iterations: int = 1,
    data_dir: str = "./data",
    synthetic_classes: int = 0,
    synthetic_flows: int = 0,
) -> dict[str, Any]:
    """Run a local benchmark for ingest + query response times."""
    export_path = Path(export_dir).expanduser().resolve()
    synthetic_generated = False
    if synthetic_classes > 0 or synthetic_flows > 0:
        export_path = Path(
            generate_synthetic_export(
                output_dir=str(export_path),
                class_count=max(1, synthetic_classes or 1),
                flow_count=max(1, synthetic_flows or 1),
            )
        )
        synthetic_generated = True
    data_path = Path(data_dir)
    data_path.mkdir(parents=True, exist_ok=True)

    graph = DuckPGQStore(db_path=str(data_path / "sfgraph.duckdb"))
    vectors = VectorStore(path=str(data_path / "vectors"))
    manifest = ManifestStore(db_path=str(data_path / "manifest.sqlite"))
    pool = NodeParserPool()

    await manifest.initialize()
    await vectors.initialize()
    await pool.start()

    try:
        ingest_service = IngestionService(
            graph=graph,
            manifest=manifest,
            pool=pool,
            vectors=vectors,
            ingestion_meta_path=str(data_path / "ingestion_meta.json"),
        )
        t0 = time.monotonic()
        ingest_summary = await ingest_service.ingest(str(export_path))
        ingest_seconds = round(time.monotonic() - t0, 3)

        query_service = GraphQueryService(
            graph=graph,
            manifest=manifest,
            vectors=vectors,
            repo_root=str(Path.cwd()),
            ingestion_meta_path=str(data_path / "ingestion_meta.json"),
        )
        samples = query_samples or [
            "what uses Account.Status__c?",
            "what breaks if I change Account.Status__c?",
            "cross layer flow map for Account.Status__c",
        ]

        latencies: list[float] = []
        query_runs: list[dict[str, Any]] = []
        for _ in range(max(1, query_iterations)):
            for sample in samples:
                q0 = time.monotonic()
                payload = await query_service.query(sample, max_results=30, max_hops=4)
                latency = round(time.monotonic() - q0, 4)
                latencies.append(latency)
                query_runs.append(
                    {
                        "question": sample,
                        "latency_seconds": latency,
                        "mode": payload.get("mode"),
                        "partial_results": payload.get("partial_results", False),
                    }
                )

        p50 = statistics.median(latencies) if latencies else 0.0
        p95 = statistics.quantiles(latencies, n=20)[18] if len(latencies) >= 20 else max(latencies or [0.0])
        thresholds = {
            "ingest_lt_180s": ingest_seconds < 180.0,
            "query_p95_lt_5s": p95 < 5.0,
        }
        return {
            "export_dir": str(export_path),
            "synthetic_generated": synthetic_generated,
            "synthetic_classes": synthetic_classes,
            "synthetic_flows": synthetic_flows,
            "ingest_seconds": ingest_seconds,
            "ingest_summary": ingest_summary.model_dump(),
            "ingest_total_nodes": ingest_summary.total_nodes,
            "query_runs": query_runs,
            "query_latency_seconds": {
                "count": len(latencies),
                "p50": round(float(p50), 4),
                "p95": round(float(p95), 4),
                "max": round(float(max(latencies or [0.0])), 4),
            },
            "thresholds": thresholds,
        }
    finally:
        await pool.shutdown()
        await manifest.close()
        await graph.close()
