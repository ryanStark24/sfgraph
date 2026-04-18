"""Command-line entrypoints for sfgraph."""
from __future__ import annotations

import argparse
import asyncio
import inspect
import json
import time
from pathlib import Path
from typing import Any

from sfgraph.benchmark import run_benchmark
from sfgraph.mcp_selftest import render_selftest_markdown, run_mcp_selftest
from sfgraph.ingestion.scope_migration import ScopeMigrationService
from sfgraph.ingestion.service import IngestionService
from sfgraph.parser.pool import NodeParserPool
from sfgraph.query.graph_query_service import GraphQueryService
from sfgraph.storage.duckpgq_store import DuckPGQStore
from sfgraph.storage.manifest_store import ManifestStore
from sfgraph.storage.parse_cache import ParseCache
from sfgraph.storage.vector_store import VectorStore


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="sfgraph", description="Salesforce graph analyzer CLI")
    sub = parser.add_subparsers(dest="command", required=True)

    serve = sub.add_parser("serve", help="Run MCP server")
    serve.set_defaults(func=_cmd_serve)

    daemon = sub.add_parser("daemon", help="Run the local sfgraph daemon")
    daemon.add_argument("--data-dir", default="./data")
    daemon.add_argument("--host", default="127.0.0.1")
    daemon.add_argument("--port", type=int, required=True)
    daemon.set_defaults(func=_cmd_daemon)

    ingest = sub.add_parser("ingest", help="Run full ingest for an export directory (defaults to workspace-root force-app/ and vlocity/ when present)")
    ingest.add_argument("export_dir")
    ingest.add_argument("--data-dir", default="./data")
    ingest.add_argument("--mode", choices=("full", "graph_only"), default="full")
    ingest.add_argument("--include", action="append", default=[], help="Include glob relative to export root. Overrides the default force-app/vlocity root selection.")
    ingest.add_argument("--exclude", action="append", default=[], help="Exclude glob relative to export root")
    ingest.add_argument("--org-alias", default=None, help="Salesforce org alias to enrich ingest metadata (optional)")
    ingest.add_argument("--enrich-org", action="store_true", help="Use Salesforce CLI metadata probes during ingest/refresh")
    ingest.set_defaults(func=_cmd_ingest)

    refresh = sub.add_parser("refresh", help="Run incremental refresh for an export directory (defaults to workspace-root force-app/ and vlocity/ when present)")
    refresh.add_argument("export_dir")
    refresh.add_argument("--data-dir", default="./data")
    refresh.add_argument("--mode", choices=("full", "graph_only"), default="full")
    refresh.add_argument("--include", action="append", default=[], help="Include glob relative to export root. Overrides the default force-app/vlocity root selection.")
    refresh.add_argument("--exclude", action="append", default=[], help="Exclude glob relative to export root")
    refresh.add_argument("--org-alias", default=None, help="Salesforce org alias to enrich ingest metadata (optional)")
    refresh.add_argument("--enrich-org", action="store_true", help="Use Salesforce CLI metadata probes during ingest/refresh")
    refresh.set_defaults(func=_cmd_refresh)

    vectorize = sub.add_parser("vectorize", help="Rebuild vectors for an already ingested export")
    vectorize.add_argument("export_dir")
    vectorize.add_argument("--data-dir", default="./data")
    vectorize.set_defaults(func=_cmd_vectorize)

    query = sub.add_parser("query", help="Run graph query")
    query.add_argument("question")
    query.add_argument("--data-dir", default="./data")
    query.add_argument("--max-hops", type=int, default=3)
    query.add_argument("--max-results", type=int, default=50)
    query.set_defaults(func=_cmd_query)

    status = sub.add_parser("status", help="Show ingestion/graph status")
    status.add_argument("--data-dir", default="./data")
    status.set_defaults(func=_cmd_status)

    progress = sub.add_parser("progress", help="Show live ingestion progress, if available")
    progress.add_argument("--data-dir", default="./data")
    progress.set_defaults(func=_cmd_progress)

    diagnostics = sub.add_parser("diagnostics", help="Render ingestion diagnostics markdown")
    diagnostics.add_argument("--data-dir", default="./data")
    diagnostics.add_argument("--destination", default=None)
    diagnostics.set_defaults(func=_cmd_diagnostics)

    subgraph = sub.add_parser("subgraph", help="Render a graph neighborhood around a node or question")
    subgraph.add_argument("--data-dir", default="./data")
    subgraph.add_argument("--node-id", default=None)
    subgraph.add_argument("--question", default=None)
    subgraph.add_argument("--hops", type=int, default=2)
    subgraph.add_argument("--max-nodes", type=int, default=80)
    subgraph.add_argument("--format", choices=("mermaid", "json"), default="mermaid")
    subgraph.add_argument("--focus", default="lineage")
    subgraph.set_defaults(func=_cmd_subgraph)

    migrate = sub.add_parser("migrate-scope", help="Migrate legacy unscoped rows for a project")
    migrate.add_argument("export_dir")
    migrate.add_argument("--data-dir", default="./data")
    migrate.add_argument("--apply", action="store_true", help="Apply migration (default dry-run)")
    migrate.add_argument("--prune-legacy", action="store_true")
    migrate.set_defaults(func=_cmd_migrate_scope)

    benchmark = sub.add_parser("benchmark", help="Run ingest/query benchmark")
    benchmark.add_argument("export_dir")
    benchmark.add_argument("--data-dir", default="./data")
    benchmark.add_argument("--query-iterations", type=int, default=1)
    benchmark.add_argument("--synthetic-classes", type=int, default=0)
    benchmark.add_argument("--synthetic-flows", type=int, default=0)
    benchmark.set_defaults(func=_cmd_benchmark)

    acceptance = sub.add_parser("acceptance", help="Run a question suite and report quality/latency/token-size estimates")
    acceptance.add_argument("--data-dir", default="./data")
    acceptance.add_argument(
        "--suite",
        default="docs/acceptance_question_suite.json",
        help="Path to JSON suite file with an array of {id, question, expected_mode?}",
    )
    acceptance.set_defaults(func=_cmd_acceptance)

    selftest = sub.add_parser("selftest", help="Run MCP/daemon-level ingest + analyze benchmark against a repo and suite")
    selftest.add_argument("export_dir")
    selftest.add_argument("--data-dir", default="./data")
    selftest.add_argument("--suite", default="docs/acceptance_quality_gate_suite.json")
    selftest.add_argument("--mode", choices=("full", "graph_only"), default="graph_only")
    selftest.add_argument("--include", action="append", default=[], help="Include glob relative to export root.")
    selftest.add_argument("--exclude", action="append", default=[], help="Exclude glob relative to export root.")
    selftest.add_argument("--poll-interval", type=float, default=0.5)
    selftest.add_argument("--timeout-seconds", type=float, default=3600.0)
    selftest.add_argument("--report-md", default=None, help="Optional path to write a markdown selftest report.")
    selftest.set_defaults(func=_cmd_selftest)
    return parser


async def _build_runtime(data_dir: str, needs_pool: bool = False, enable_vectors: bool = True) -> dict[str, Any]:
    data_path = Path(data_dir)
    data_path.mkdir(parents=True, exist_ok=True)
    graph = DuckPGQStore(db_path=str(data_path / "sfgraph.duckdb"))
    vectors = VectorStore(path=str(data_path / "vectors")) if enable_vectors else None
    manifest = ManifestStore(db_path=str(data_path / "manifest.sqlite"))
    parse_cache = ParseCache(db_path=str(data_path / "parse_cache.sqlite"))
    await manifest.initialize()
    await parse_cache.initialize()
    if vectors is not None:
        await vectors.initialize()

    pool = NodeParserPool()
    if needs_pool:
        await pool.start()
    return {"graph": graph, "vectors": vectors, "manifest": manifest, "parse_cache": parse_cache, "pool": pool, "needs_pool": needs_pool}


async def _close_runtime(runtime: dict[str, Any]) -> None:
    if runtime.get("needs_pool"):
        await runtime["pool"].shutdown()
    await runtime["parse_cache"].close()
    await runtime["manifest"].close()
    await runtime["graph"].close()


def _cmd_serve(_args: argparse.Namespace) -> int:
    from sfgraph.server import mcp

    mcp.run()
    return 0


def _cmd_daemon(args: argparse.Namespace) -> int:
    from sfgraph.daemon import main as daemon_main

    return daemon_main(["--data-dir", args.data_dir, "--host", args.host, "--port", str(args.port)])


async def _cmd_ingest(args: argparse.Namespace) -> int:
    runtime = await _build_runtime(args.data_dir, needs_pool=True, enable_vectors=args.mode != "graph_only")
    try:
        service = IngestionService(
            graph=runtime["graph"],
            manifest=runtime["manifest"],
            parse_cache=runtime["parse_cache"],
            pool=runtime["pool"],
            vectors=runtime["vectors"],
            ingestion_meta_path=str(Path(args.data_dir) / "ingestion_meta.json"),
            ingestion_progress_path=str(Path(args.data_dir) / "ingestion_progress.json"),
            include_globs=args.include,
            exclude_globs=args.exclude,
            org_alias=args.org_alias,
            enrich_org=bool(args.enrich_org),
        )
        summary = await service.ingest(args.export_dir)
        print(json.dumps(summary.model_dump(), indent=2))
        return 0
    finally:
        await _close_runtime(runtime)


async def _cmd_refresh(args: argparse.Namespace) -> int:
    runtime = await _build_runtime(args.data_dir, needs_pool=True, enable_vectors=args.mode != "graph_only")
    try:
        service = IngestionService(
            graph=runtime["graph"],
            manifest=runtime["manifest"],
            parse_cache=runtime["parse_cache"],
            pool=runtime["pool"],
            vectors=runtime["vectors"],
            ingestion_meta_path=str(Path(args.data_dir) / "ingestion_meta.json"),
            ingestion_progress_path=str(Path(args.data_dir) / "ingestion_progress.json"),
            include_globs=args.include,
            exclude_globs=args.exclude,
            org_alias=args.org_alias,
            enrich_org=bool(args.enrich_org),
        )
        summary = await service.refresh(args.export_dir)
        print(json.dumps(summary.model_dump(), indent=2))
        return 0
    finally:
        await _close_runtime(runtime)


async def _cmd_query(args: argparse.Namespace) -> int:
    runtime = await _build_runtime(args.data_dir, needs_pool=False)
    try:
        service = GraphQueryService(
            graph=runtime["graph"],
            manifest=runtime["manifest"],
            vectors=runtime["vectors"],
            repo_root=str(Path.cwd()),
            ingestion_meta_path=str(Path(args.data_dir) / "ingestion_meta.json"),
            ingestion_progress_path=str(Path(args.data_dir) / "ingestion_progress.json"),
        )
        payload = await service.query(
            args.question,
            max_hops=args.max_hops,
            max_results=args.max_results,
        )
        print(json.dumps(payload, indent=2))
        return 0
    finally:
        await _close_runtime(runtime)


async def _cmd_diagnostics(args: argparse.Namespace) -> int:
    runtime = await _build_runtime(args.data_dir, needs_pool=False)
    try:
        service = GraphQueryService(
            graph=runtime["graph"],
            manifest=runtime["manifest"],
            vectors=runtime["vectors"],
            repo_root=str(Path.cwd()),
            ingestion_meta_path=str(Path(args.data_dir) / "ingestion_meta.json"),
            ingestion_progress_path=str(Path(args.data_dir) / "ingestion_progress.json"),
        )
        payload = await service.export_diagnostics_md(destination=args.destination)
        print(json.dumps(payload, indent=2))
        return 0
    finally:
        await _close_runtime(runtime)


async def _cmd_subgraph(args: argparse.Namespace) -> int:
    runtime = await _build_runtime(args.data_dir, needs_pool=False)
    try:
        service = GraphQueryService(
            graph=runtime["graph"],
            manifest=runtime["manifest"],
            vectors=runtime["vectors"],
            repo_root=str(Path.cwd()),
            ingestion_meta_path=str(Path(args.data_dir) / "ingestion_meta.json"),
            ingestion_progress_path=str(Path(args.data_dir) / "ingestion_progress.json"),
        )
        payload = await service.graph_subgraph(
            node_id=args.node_id,
            question=args.question,
            hops=args.hops,
            max_nodes=args.max_nodes,
            format=args.format,
            focus=args.focus,
        )
        print(json.dumps(payload, indent=2))
        return 0
    finally:
        await _close_runtime(runtime)


async def _cmd_vectorize(args: argparse.Namespace) -> int:
    runtime = await _build_runtime(args.data_dir, needs_pool=False, enable_vectors=True)
    try:
        service = IngestionService(
            graph=runtime["graph"],
            manifest=runtime["manifest"],
            parse_cache=runtime["parse_cache"],
            pool=runtime["pool"],
            vectors=runtime["vectors"],
            ingestion_meta_path=str(Path(args.data_dir) / "ingestion_meta.json"),
            ingestion_progress_path=str(Path(args.data_dir) / "ingestion_progress.json"),
        )
        summary = await service.vectorize(args.export_dir)
        print(json.dumps(summary.model_dump(), indent=2))
        return 0
    finally:
        await _close_runtime(runtime)


async def _cmd_status(args: argparse.Namespace) -> int:
    runtime = await _build_runtime(args.data_dir, needs_pool=False)
    try:
        service = GraphQueryService(
            graph=runtime["graph"],
            manifest=runtime["manifest"],
            vectors=runtime["vectors"],
            repo_root=str(Path.cwd()),
            ingestion_meta_path=str(Path(args.data_dir) / "ingestion_meta.json"),
            ingestion_progress_path=str(Path(args.data_dir) / "ingestion_progress.json"),
        )
        payload = await service.get_ingestion_status()
        print(json.dumps(payload, indent=2))
        return 0
    finally:
        await _close_runtime(runtime)


async def _cmd_progress(args: argparse.Namespace) -> int:
    runtime = await _build_runtime(args.data_dir, needs_pool=False)
    try:
        service = GraphQueryService(
            graph=runtime["graph"],
            manifest=runtime["manifest"],
            vectors=runtime["vectors"],
            repo_root=str(Path.cwd()),
            ingestion_meta_path=str(Path(args.data_dir) / "ingestion_meta.json"),
            ingestion_progress_path=str(Path(args.data_dir) / "ingestion_progress.json"),
        )
        payload = await service.get_ingestion_progress()
        print(json.dumps(payload, indent=2))
        return 0
    finally:
        await _close_runtime(runtime)


async def _cmd_migrate_scope(args: argparse.Namespace) -> int:
    runtime = await _build_runtime(args.data_dir, needs_pool=False)
    try:
        service = ScopeMigrationService(graph=runtime["graph"], vectors=runtime["vectors"])
        payload = await service.migrate_project_scope(
            export_dir=args.export_dir,
            dry_run=not args.apply,
            prune_legacy=args.prune_legacy,
        )
        print(json.dumps(payload, indent=2))
        return 0
    finally:
        await _close_runtime(runtime)


async def _cmd_benchmark(args: argparse.Namespace) -> int:
    payload = await run_benchmark(
        export_dir=args.export_dir,
        query_iterations=args.query_iterations,
        data_dir=args.data_dir,
        synthetic_classes=args.synthetic_classes,
        synthetic_flows=args.synthetic_flows,
    )
    print(json.dumps(payload, indent=2))
    return 0


def _estimate_tokens(text: str) -> int:
    # Rough estimate for trend tracking in acceptance runs.
    return max(1, (len(text) + 3) // 4)


async def _cmd_acceptance(args: argparse.Namespace) -> int:
    suite_path = Path(args.suite).expanduser().resolve()
    if not suite_path.exists():
        raise FileNotFoundError(f"Suite file not found: {suite_path}")
    raw = json.loads(suite_path.read_text(encoding="utf-8"))
    if not isinstance(raw, list):
        raise ValueError("Acceptance suite must be a JSON array.")

    runtime = await _build_runtime(args.data_dir, needs_pool=False)
    try:
        service = GraphQueryService(
            graph=runtime["graph"],
            manifest=runtime["manifest"],
            vectors=runtime["vectors"],
            repo_root=str(Path.cwd()),
            ingestion_meta_path=str(Path(args.data_dir) / "ingestion_meta.json"),
            ingestion_progress_path=str(Path(args.data_dir) / "ingestion_progress.json"),
        )
        results: list[dict[str, Any]] = []
        passed_expectations = 0
        expectation_count = 0
        for idx, entry in enumerate(raw, start=1):
            if not isinstance(entry, dict):
                continue
            question = str(entry.get("question", "")).strip()
            if not question:
                continue
            case_id = str(entry.get("id") or f"q{idx}")
            expected_mode = entry.get("expected_mode")
            t0 = time.perf_counter()
            payload = await service.query(question, max_hops=3, max_results=50)
            elapsed_ms = round((time.perf_counter() - t0) * 1000, 2)
            response_json = json.dumps(payload, separators=(",", ":"))
            mode = str(payload.get("mode", "unknown"))
            status = "info"
            if expected_mode is not None:
                expectation_count += 1
                if mode == str(expected_mode):
                    passed_expectations += 1
                    status = "pass"
                else:
                    status = "fail"
            results.append(
                {
                    "id": case_id,
                    "question": question,
                    "mode": mode,
                    "expected_mode": expected_mode,
                    "status": status,
                    "duration_ms": elapsed_ms,
                    "response_bytes": len(response_json.encode("utf-8")),
                    "response_tokens_est": _estimate_tokens(response_json),
                    "partial_results": bool(payload.get("partial_results", False)),
                }
            )

        total = len(results)
        summary = {
            "suite_path": str(suite_path),
            "total_cases": total,
            "expectation_count": expectation_count,
            "expectation_passed": passed_expectations,
            "expectation_pass_rate": round((passed_expectations / expectation_count), 3) if expectation_count else None,
            "avg_duration_ms": round(sum(item["duration_ms"] for item in results) / total, 2) if total else 0.0,
            "avg_response_tokens_est": round(sum(item["response_tokens_est"] for item in results) / total, 2) if total else 0.0,
        }
        print(json.dumps({"summary": summary, "cases": results}, indent=2))
        return 0
    finally:
        await _close_runtime(runtime)


def _cmd_selftest(args: argparse.Namespace) -> int:
    payload = run_mcp_selftest(
        export_dir=args.export_dir,
        data_dir=args.data_dir,
        suite_path=args.suite,
        include_globs=args.include,
        exclude_globs=args.exclude,
        mode=args.mode,
        poll_interval_seconds=float(args.poll_interval),
        timeout_seconds=float(args.timeout_seconds),
    )
    print(json.dumps(payload, indent=2))
    if args.report_md:
        report_path = Path(args.report_md).expanduser().resolve()
        report_path.parent.mkdir(parents=True, exist_ok=True)
        report_path.write_text(render_selftest_markdown(payload), encoding="utf-8")
    return 0


def main(argv: list[str] | None = None) -> int:
    parser = _build_parser()
    args = parser.parse_args(argv)
    func = args.func
    result = func(args)
    if inspect.isawaitable(result):
        return asyncio.run(result)
    return int(result)


if __name__ == "__main__":
    raise SystemExit(main())
