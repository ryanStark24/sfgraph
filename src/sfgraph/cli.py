"""Command-line entrypoints for sfgraph."""
from __future__ import annotations

import argparse
import asyncio
import json
from pathlib import Path
from typing import Any

from sfgraph.benchmark import run_benchmark
from sfgraph.ingestion.scope_migration import ScopeMigrationService
from sfgraph.ingestion.service import IngestionService
from sfgraph.parser.pool import NodeParserPool
from sfgraph.query.graph_query_service import GraphQueryService
from sfgraph.storage.duckpgq_store import DuckPGQStore
from sfgraph.storage.manifest_store import ManifestStore
from sfgraph.storage.vector_store import VectorStore


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="sfgraph", description="Salesforce graph analyzer CLI")
    sub = parser.add_subparsers(dest="command", required=True)

    serve = sub.add_parser("serve", help="Run MCP server")
    serve.set_defaults(func=_cmd_serve)

    ingest = sub.add_parser("ingest", help="Run full ingest for an export directory")
    ingest.add_argument("export_dir")
    ingest.add_argument("--data-dir", default="./data")
    ingest.set_defaults(func=_cmd_ingest)

    refresh = sub.add_parser("refresh", help="Run incremental refresh for an export directory")
    refresh.add_argument("export_dir")
    refresh.add_argument("--data-dir", default="./data")
    refresh.set_defaults(func=_cmd_refresh)

    query = sub.add_parser("query", help="Run graph query")
    query.add_argument("question")
    query.add_argument("--data-dir", default="./data")
    query.add_argument("--max-hops", type=int, default=3)
    query.add_argument("--max-results", type=int, default=50)
    query.set_defaults(func=_cmd_query)

    status = sub.add_parser("status", help="Show ingestion/graph status")
    status.add_argument("--data-dir", default="./data")
    status.set_defaults(func=_cmd_status)

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
    return parser


async def _build_runtime(data_dir: str, needs_pool: bool = False) -> dict[str, Any]:
    data_path = Path(data_dir)
    data_path.mkdir(parents=True, exist_ok=True)
    graph = DuckPGQStore(db_path=str(data_path / "sfgraph.duckdb"))
    vectors = VectorStore(path=str(data_path / "vectors"))
    manifest = ManifestStore(db_path=str(data_path / "manifest.sqlite"))
    await manifest.initialize()
    await vectors.initialize()

    pool = NodeParserPool()
    if needs_pool:
        await pool.start()
    return {"graph": graph, "vectors": vectors, "manifest": manifest, "pool": pool, "needs_pool": needs_pool}


async def _close_runtime(runtime: dict[str, Any]) -> None:
    if runtime.get("needs_pool"):
        await runtime["pool"].shutdown()
    await runtime["manifest"].close()
    await runtime["graph"].close()


async def _cmd_serve(_args: argparse.Namespace) -> int:
    from sfgraph.server import mcp

    mcp.run()
    return 0


async def _cmd_ingest(args: argparse.Namespace) -> int:
    runtime = await _build_runtime(args.data_dir, needs_pool=True)
    try:
        service = IngestionService(
            graph=runtime["graph"],
            manifest=runtime["manifest"],
            pool=runtime["pool"],
            vectors=runtime["vectors"],
            ingestion_meta_path=str(Path(args.data_dir) / "ingestion_meta.json"),
        )
        summary = await service.ingest(args.export_dir)
        print(json.dumps(summary.model_dump(), indent=2))
        return 0
    finally:
        await _close_runtime(runtime)


async def _cmd_refresh(args: argparse.Namespace) -> int:
    runtime = await _build_runtime(args.data_dir, needs_pool=True)
    try:
        service = IngestionService(
            graph=runtime["graph"],
            manifest=runtime["manifest"],
            pool=runtime["pool"],
            vectors=runtime["vectors"],
            ingestion_meta_path=str(Path(args.data_dir) / "ingestion_meta.json"),
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


async def _cmd_status(args: argparse.Namespace) -> int:
    runtime = await _build_runtime(args.data_dir, needs_pool=False)
    try:
        service = GraphQueryService(
            graph=runtime["graph"],
            manifest=runtime["manifest"],
            vectors=runtime["vectors"],
            repo_root=str(Path.cwd()),
            ingestion_meta_path=str(Path(args.data_dir) / "ingestion_meta.json"),
        )
        payload = await service.get_ingestion_status()
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


def main(argv: list[str] | None = None) -> int:
    parser = _build_parser()
    args = parser.parse_args(argv)
    func = args.func
    return asyncio.run(func(args))


if __name__ == "__main__":
    raise SystemExit(main())
