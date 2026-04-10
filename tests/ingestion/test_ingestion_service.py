"""Tests for IngestionService and schema index generation."""
from __future__ import annotations

import json
from pathlib import Path
from unittest.mock import AsyncMock

import pytest

from sfgraph.ingestion.models import IngestionSummary
from sfgraph.ingestion.schema_index import materialize_schema_index
from sfgraph.ingestion.service import IngestionService

FIXTURE_EXPORT = "tests/fixtures/metadata"


def make_mock_graph() -> AsyncMock:
    graph = AsyncMock()
    graph.merge_node = AsyncMock(side_effect=lambda label, key_props, all_props: key_props.get("qualifiedName", "qn"))
    graph.merge_nodes_batch = AsyncMock(side_effect=lambda label, nodes: len(nodes))
    graph.merge_edge = AsyncMock(return_value=None)
    graph.merge_edges_batch = AsyncMock(side_effect=lambda rel_type, edges: len(edges))
    graph.delete_node = AsyncMock(return_value=True)
    graph.delete_edge = AsyncMock(return_value=True)
    graph.delete_edges_for_node = AsyncMock(return_value=1)
    graph.get_labels = AsyncMock(return_value=["ApexClass", "SFObject", "SFField", "Flow"])
    graph.get_relationship_types = AsyncMock(return_value=["CALLS", "QUERIES_OBJECT", "FLOW_CALLS_APEX"])
    graph.query = AsyncMock(return_value=[])
    return graph


def make_mock_manifest() -> AsyncMock:
    manifest = AsyncMock()
    manifest.create_run = AsyncMock(return_value="run-test-001")
    manifest.upsert_file = AsyncMock(return_value=None)
    manifest.set_status = AsyncMock(return_value=None)
    manifest.mark_run_complete = AsyncMock(return_value=None)
    manifest.get_delta = AsyncMock(return_value={"new": [], "changed": [], "unchanged": [], "deleted": []})
    manifest.get_tracked_files = AsyncMock(return_value={})
    manifest.delete_files = AsyncMock(return_value=0)
    return manifest


def make_mock_pool() -> AsyncMock:
    pool = AsyncMock()
    pool.parse = AsyncMock(
        return_value={
            "ok": True,
            "payload": {
                "filePath": "AccountService.cls",
                "hasError": False,
                "nodes": [
                    {
                        "nodeType": "ApexClass",
                        "name": "AccountService",
                        "superclass": None,
                        "interfaces": [],
                        "annotations": [],
                        "isTest": False,
                        "startLine": 1,
                    }
                ],
                "potential_refs": [],
            },
        }
    )
    return pool


@pytest.fixture
def svc():
    graph = make_mock_graph()
    manifest = make_mock_manifest()
    pool = make_mock_pool()
    service = IngestionService(
        graph=graph,
        manifest=manifest,
        pool=pool,
        schema_index_path="/tmp/test_schema_index.json",
        ingestion_progress_path="/tmp/test_ingestion_progress.json",
    )
    return service, graph, manifest, pool


@pytest.mark.asyncio
async def test_ingest_returns_summary(svc):
    service, _, _, _ = svc
    summary = await service.ingest(FIXTURE_EXPORT)
    assert isinstance(summary, IngestionSummary)
    assert summary.run_id == "run-test-001"
    assert summary.duration_seconds > 0


@pytest.mark.asyncio
async def test_ingest_calls_merge_node_before_merge_edge(svc):
    service, graph, _, _ = svc
    await service.ingest(FIXTURE_EXPORT)
    calls = graph.mock_calls
    node_indices = []
    for i, c in enumerate(calls):
        if "merge_node" not in str(c):
            continue
        # Ignore edge-time stub node creation; verify only phase-1 real nodes.
        args = getattr(c, "args", ())
        props = args[2] if len(args) >= 3 else {}
        if isinstance(props, dict) and props.get("parserType") == "stub":
            continue
        node_indices.append(i)
    edge_indices = [i for i, c in enumerate(calls) if "merge_edge" in str(c)]
    if node_indices and edge_indices:
        assert max(node_indices) < min(edge_indices)


@pytest.mark.asyncio
async def test_ingest_calls_manifest_statuses_in_order(svc):
    service, _, manifest, _ = svc
    await service.ingest(FIXTURE_EXPORT)
    status_calls = [str(c) for c in manifest.set_status.call_args_list]
    nodes_written_idx = next((i for i, c in enumerate(status_calls) if "NODES_WRITTEN" in c), None)
    edges_written_idx = next((i for i, c in enumerate(status_calls) if "EDGES_WRITTEN" in c), None)
    if nodes_written_idx is not None and edges_written_idx is not None:
        assert nodes_written_idx < edges_written_idx


@pytest.mark.asyncio
async def test_ingest_node_counts_by_type(svc):
    service, _, _, _ = svc
    summary = await service.ingest(FIXTURE_EXPORT)
    assert summary.total_nodes >= 1


@pytest.mark.asyncio
async def test_ingest_parse_failure_does_not_crash(svc):
    service, _, _, pool = svc
    pool.parse = AsyncMock(
        return_value={
            "ok": False,
            "error": "parse_error",
            "payload": {
                "errorLine": 42,
                "errorColumn": 7,
                "errorNodeType": "ERROR",
                "contextSnippet": "public class Broken {",
                "fileSizeBytes": 1234,
            },
        }
    )
    summary = await service.ingest(FIXTURE_EXPORT)
    assert isinstance(summary, IngestionSummary)


@pytest.mark.asyncio
async def test_ingest_parse_failure_logs_diagnostics(svc, caplog):
    service, _, _, pool = svc
    pool.parse = AsyncMock(
        return_value={
            "ok": False,
            "error": "parse_error",
            "payload": {
                "errorLine": 42,
                "errorColumn": 7,
                "errorNodeType": "ERROR",
                "contextSnippet": "public class Broken {",
                "fileSizeBytes": 1234,
                "classNames": ["Broken"],
                "topLevelKinds": ["class_declaration"],
            },
        }
    )

    summary = await service.ingest(FIXTURE_EXPORT)
    assert summary.parse_failures
    assert "error_location=line 42, col 7" in caplog.text
    assert "error_node=ERROR" in caplog.text
    assert "file_size_bytes=1234" in caplog.text
    assert "classes=Broken" in caplog.text


@pytest.mark.asyncio
async def test_vectorize_rebuilds_vectors_for_active_scope(tmp_path):
    graph = make_mock_graph()
    manifest = make_mock_manifest()
    pool = make_mock_pool()
    vectors = AsyncMock()
    vectors.delete_by_project_scope = AsyncMock(return_value=2)
    vectors.upsert = AsyncMock(return_value=None)
    service = IngestionService(
        graph=graph,
        manifest=manifest,
        pool=pool,
        vectors=vectors,
        ingestion_progress_path=str(tmp_path / "progress.json"),
    )
    export_dir = str(tmp_path / "repo")
    Path(export_dir).mkdir(parents=True, exist_ok=True)
    scope = service._activate_scope(export_dir)
    scoped_qname = f"{service._active_project_scope}::AccountService"
    graph.get_labels = AsyncMock(return_value=["ApexClass"])
    graph.query = AsyncMock(
        return_value=[
            {
                "qualified_name": scoped_qname,
                "props": json.dumps(
                    {
                        "qualifiedName": "AccountService",
                        "sourceFile": "classes/AccountService.cls",
                        "parserType": "apex_cst",
                        "projectScope": service._active_project_scope,
                        "label": "ApexClass",
                    }
                ),
            }
        ]
    )

    summary = await service.vectorize(scope)
    assert summary.processed_nodes == 1
    assert summary.failed_nodes == 0
    vectors.delete_by_project_scope.assert_awaited()
    vectors.upsert.assert_awaited()


@pytest.mark.asyncio
async def test_vectorize_counts_failed_upserts(tmp_path):
    graph = make_mock_graph()
    manifest = make_mock_manifest()
    pool = make_mock_pool()
    vectors = AsyncMock()
    vectors.delete_by_project_scope = AsyncMock(return_value=0)
    vectors.upsert = AsyncMock(side_effect=RuntimeError("vector backend unavailable"))
    service = IngestionService(
        graph=graph,
        manifest=manifest,
        pool=pool,
        vectors=vectors,
        ingestion_progress_path=str(tmp_path / "progress.json"),
    )
    export_dir = str(tmp_path / "repo")
    Path(export_dir).mkdir(parents=True, exist_ok=True)
    scope = service._activate_scope(export_dir)
    scoped_qname = f"{service._active_project_scope}::AccountService"
    graph.get_labels = AsyncMock(return_value=["ApexClass"])
    graph.query = AsyncMock(
        return_value=[
            {
                "qualified_name": scoped_qname,
                "props": json.dumps(
                    {
                        "qualifiedName": "AccountService",
                        "sourceFile": "classes/AccountService.cls",
                        "parserType": "apex_cst",
                        "projectScope": service._active_project_scope,
                        "label": "ApexClass",
                    }
                ),
            }
        ]
    )

    summary = await service.vectorize(scope)
    assert summary.processed_nodes == 0
    assert summary.failed_nodes == 1
    assert summary.skipped_nodes == 0
    assert len(summary.warnings) == 2
    assert "Vector upsert failed for" in summary.warnings[0]


@pytest.mark.asyncio
async def test_ingest_merge_node_has_source_attribution(svc):
    service, graph, _, _ = svc
    await service.ingest(FIXTURE_EXPORT)
    for call in graph.merge_node.call_args_list:
        key_props = call.args[1]
        all_props = call.args[2]
        assert "::" in key_props["qualifiedName"]
        assert "projectScope" in all_props
        assert all_props["scopedQualifiedName"] == key_props["qualifiedName"]
        assert "sourceFile" in all_props
        assert "parserType" in all_props


@pytest.mark.asyncio
async def test_ingest_merge_edge_has_edge_attribution(svc):
    service, graph, _, pool = svc
    pool.parse = AsyncMock(
        return_value={
            "ok": True,
            "payload": {
                "filePath": "AccountService.cls",
                "hasError": False,
                "nodes": [
                    {
                        "nodeType": "ApexClass",
                        "name": "AccountService",
                        "superclass": None,
                        "interfaces": [],
                        "annotations": [],
                        "isTest": False,
                        "startLine": 1,
                    },
                    {
                        "nodeType": "ApexClass",
                        "name": "ContactService",
                        "superclass": None,
                        "interfaces": [],
                        "annotations": [],
                        "isTest": False,
                        "startLine": 2,
                    },
                ],
                "potential_refs": [
                    {
                        "refType": "CALLS_CLASS_METHOD",
                        "targetClass": "ContactService",
                        "method": "notifyContacts",
                        "startLine": 5,
                        "contextSnippet": "ContactService.notifyContacts(id)",
                    }
                ],
            },
        }
    )

    async def assert_props(src_qn, src_label, rel_type, dst_qn, dst_label, props):
        assert "confidence" in props
        assert "resolutionMethod" in props
        assert "edgeCategory" in props
        assert "contextSnippet" in props

    graph.merge_edge.side_effect = assert_props

    await service.ingest(FIXTURE_EXPORT)


@pytest.mark.asyncio
async def test_schema_index_materialized(svc, tmp_path):
    service, _, _, _ = svc
    schema_path = tmp_path / "schema_index.json"
    service._schema_index_path = str(schema_path)
    await service.ingest(FIXTURE_EXPORT)
    assert schema_path.exists()
    schema = json.loads(schema_path.read_text(encoding="utf-8"))
    assert "node_types" in schema
    assert "relationship_types" in schema
    assert "edge_categories" in schema
    assert set(schema["edge_categories"]) == {"DATA_FLOW", "CONTROL_FLOW", "CONFIG", "STRUCTURAL"}


@pytest.mark.asyncio
async def test_materialize_schema_index_writes_json(tmp_path):
    graph = AsyncMock()
    graph.get_labels = AsyncMock(return_value=["ApexClass", "SFField"])
    graph.get_relationship_types = AsyncMock(return_value=["CALLS", "READS_FIELD"])
    graph.query = AsyncMock(return_value=[{"n": {"qualifiedName": "Foo", "name": "Foo"}}])

    out = tmp_path / "schema.json"
    schema = await materialize_schema_index(graph, str(out))
    assert out.exists()
    assert "ApexClass" in schema["node_types"]
    assert "SFField" in schema["node_types"]
    assert "CALLS" in schema["relationship_types"]


@pytest.mark.asyncio
async def test_refresh_returns_summary(svc):
    service, _, manifest, _ = svc
    fixture_file = str(Path(FIXTURE_EXPORT) / "classes" / "AccountService.cls")
    manifest.get_delta = AsyncMock(
        return_value={
            "new": [fixture_file],
            "changed": [],
            "unchanged": [],
            "deleted": [],
        }
    )
    summary = await service.refresh(FIXTURE_EXPORT)
    assert summary.processed_files == 1
    assert summary.changed_files == [fixture_file]
    assert "apex" in summary.parser_stats


@pytest.mark.asyncio
async def test_watch_refresh_triggers_refresh_once(svc):
    service, _, manifest, _ = svc
    fixture_file = str(Path(FIXTURE_EXPORT) / "classes" / "AccountService.cls")
    manifest.get_delta = AsyncMock(
        side_effect=[
            {"new": [fixture_file], "changed": [], "unchanged": [], "deleted": []},
            {"new": [], "changed": [], "unchanged": [fixture_file], "deleted": []},
            {"new": [], "changed": [], "unchanged": [fixture_file], "deleted": []},
        ]
    )
    payload = await service.watch_refresh(
        export_dir=FIXTURE_EXPORT,
        duration_seconds=1,
        poll_interval=0.01,
        debounce_seconds=0.01,
        max_refreshes=1,
    )
    assert payload["refresh_count"] == 1


@pytest.mark.asyncio
async def test_ingest_retries_transient_worker_restarting(svc):
    service, _, _, pool = svc
    ok_payload = {
        "ok": True,
        "payload": {
            "filePath": "AccountService.cls",
            "hasError": False,
            "nodes": [
                {
                    "nodeType": "ApexClass",
                    "name": "AccountService",
                    "superclass": None,
                    "interfaces": [],
                    "annotations": [],
                    "isTest": False,
                    "startLine": 1,
                }
            ],
            "potential_refs": [],
        },
    }
    pool.parse = AsyncMock(
        side_effect=[
            {"ok": False, "error": "worker_restarting", "payload": None},
            ok_payload,
        ]
    )
    summary = await service.ingest(FIXTURE_EXPORT)
    assert summary.parse_failures == []


@pytest.mark.asyncio
async def test_ingest_retries_transient_worker_exited(svc):
    service, _, _, pool = svc
    ok_payload = {
        "ok": True,
        "payload": {
            "filePath": "AccountService.cls",
            "hasError": False,
            "nodes": [
                {
                    "nodeType": "ApexClass",
                    "name": "AccountService",
                    "superclass": None,
                    "interfaces": [],
                    "annotations": [],
                    "isTest": False,
                    "startLine": 1,
                }
            ],
            "potential_refs": [],
        },
    }
    pool.parse = AsyncMock(
        side_effect=[
            {"ok": False, "error": "worker_exited", "payload": None},
            ok_payload,
        ]
    )
    summary = await service.ingest(FIXTURE_EXPORT)
    assert summary.parse_failures == []


@pytest.mark.asyncio
async def test_ingest_parse_failure_preserves_worker_stderr(svc, caplog):
    service, _, _, pool = svc
    pool.parse = AsyncMock(
        return_value={
            "ok": False,
            "error": "worker_exited",
            "payload": {"worker_stderr": "[worker] init failed: missing parser"},
        }
    )

    summary = await service.ingest(FIXTURE_EXPORT)
    assert summary.parse_failures
    assert "worker_stderr=[worker] init failed: missing parser" in caplog.text


def test_discover_files_skips_tooling_dirs(svc, tmp_path):
    service, _, _, _ = svc
    good = tmp_path / "force-app" / "main" / "default" / "classes" / "Good.cls"
    bad = tmp_path / ".sfdx" / "tools" / "258" / "StandardApexLibrary" / "Bad.cls"
    good.parent.mkdir(parents=True, exist_ok=True)
    bad.parent.mkdir(parents=True, exist_ok=True)
    good.write_text("public class Good {}", encoding="utf-8")
    bad.write_text("public class Bad {}", encoding="utf-8")

    discovered = service._discover_files(tmp_path)  # type: ignore[arg-type]
    assert str(good) in discovered
    assert str(bad) not in discovered


def test_discover_files_skips_non_vlocity_json(svc, tmp_path):
    service, _, _, _ = svc
    included = tmp_path / "vlocity" / "DataRaptor" / "AccountExtract_DataPack.json"
    skipped = tmp_path / "files" / "ProductChildItems.json"
    included.parent.mkdir(parents=True, exist_ok=True)
    skipped.parent.mkdir(parents=True, exist_ok=True)
    included.write_text('{"VlocityDataPackType":"DataRaptor"}', encoding="utf-8")
    skipped.write_text('{"arbitrary": true}', encoding="utf-8")

    discovered = service._discover_files(tmp_path)  # type: ignore[arg-type]
    assert str(included) in discovered
    assert str(skipped) not in discovered


def test_discover_files_skips_nested_git_repos(svc, tmp_path):
    service, _, _, _ = svc
    outer = tmp_path / "force-app" / "main" / "default" / "classes" / "Outer.cls"
    nested_repo_root = tmp_path / "vendor" / "nested-repo"
    nested_git = nested_repo_root / ".git"
    nested_cls = nested_repo_root / "force-app" / "main" / "default" / "classes" / "Nested.cls"
    outer.parent.mkdir(parents=True, exist_ok=True)
    nested_git.mkdir(parents=True, exist_ok=True)
    nested_cls.parent.mkdir(parents=True, exist_ok=True)
    outer.write_text("public class Outer {}", encoding="utf-8")
    nested_cls.write_text("public class Nested {}", encoding="utf-8")

    discovered = service._discover_files(tmp_path)  # type: ignore[arg-type]
    assert str(outer) in discovered
    assert str(nested_cls) not in discovered


def test_discover_files_skips_temp_lock_files(svc, tmp_path):
    service, _, _, _ = svc
    valid = tmp_path / "flows" / "Quote_Process.flow-meta.xml"
    temp_lock = tmp_path / "flows" / "~$Quote_Process.flow-meta.xml"
    valid.parent.mkdir(parents=True, exist_ok=True)
    valid.write_text("<Flow />", encoding="utf-8")
    temp_lock.write_text("not real xml", encoding="utf-8")

    discovered = service._discover_files(tmp_path)  # type: ignore[arg-type]
    assert str(valid) in discovered
    assert str(temp_lock) not in discovered


def test_discover_files_skips_prefixed_temp_lock_files(svc, tmp_path):
    service, _, _, _ = svc
    valid = tmp_path / "flows" / "Quote_Process.flow-meta.xml"
    prefixed_lock = tmp_path / "flows" / "ca0d0b6db8475579__~$ote_Process_on_Create_and_Update.flow-meta.xml"
    valid.parent.mkdir(parents=True, exist_ok=True)
    valid.write_text("<Flow />", encoding="utf-8")
    prefixed_lock.write_text("not real xml", encoding="utf-8")

    discovered = service._discover_files(tmp_path)  # type: ignore[arg-type]
    assert str(valid) in discovered
    assert str(prefixed_lock) not in discovered


def test_discover_files_respects_include_exclude_globs(tmp_path):
    graph = make_mock_graph()
    manifest = make_mock_manifest()
    pool = make_mock_pool()
    service = IngestionService(
        graph=graph,
        manifest=manifest,
        pool=pool,
        include_globs=["force-app/**"],
        exclude_globs=["**/*Test.cls"],
    )
    keep = tmp_path / "force-app" / "main" / "default" / "classes" / "AccountService.cls"
    drop = tmp_path / "force-app" / "main" / "default" / "classes" / "AccountServiceTest.cls"
    other = tmp_path / "vendor" / "Repo.cls"
    keep.parent.mkdir(parents=True, exist_ok=True)
    other.parent.mkdir(parents=True, exist_ok=True)
    keep.write_text("public class AccountService {}", encoding="utf-8")
    drop.write_text("public class AccountServiceTest {}", encoding="utf-8")
    other.write_text("public class Repo {}", encoding="utf-8")

    discovered = service._discover_files(tmp_path)  # type: ignore[arg-type]
    assert str(keep) in discovered
    assert str(drop) not in discovered
    assert str(other) not in discovered


def test_discover_files_defaults_to_force_app_and_vlocity_roots(tmp_path):
    graph = make_mock_graph()
    manifest = make_mock_manifest()
    pool = make_mock_pool()
    service = IngestionService(
        graph=graph,
        manifest=manifest,
        pool=pool,
    )
    force_app_cls = tmp_path / "force-app" / "main" / "default" / "classes" / "AccountService.cls"
    vlocity_json = tmp_path / "vlocity" / "DataRaptor" / "AccountExtract_DataPack.json"
    vendor_cls = tmp_path / "vendor" / "Other.cls"
    force_app_cls.parent.mkdir(parents=True, exist_ok=True)
    vlocity_json.parent.mkdir(parents=True, exist_ok=True)
    vendor_cls.parent.mkdir(parents=True, exist_ok=True)
    force_app_cls.write_text("public class AccountService {}", encoding="utf-8")
    vlocity_json.write_text('{"VlocityDataPackType":"DataRaptor"}', encoding="utf-8")
    vendor_cls.write_text("public class Other {}", encoding="utf-8")

    discovered = service._discover_files(tmp_path)  # type: ignore[arg-type]
    assert str(force_app_cls) in discovered
    assert str(vlocity_json) in discovered
    assert str(vendor_cls) not in discovered


def test_discover_files_falls_back_to_root_when_default_roots_missing(tmp_path):
    graph = make_mock_graph()
    manifest = make_mock_manifest()
    pool = make_mock_pool()
    service = IngestionService(
        graph=graph,
        manifest=manifest,
        pool=pool,
    )
    loose_cls = tmp_path / "classes" / "Loose.cls"
    loose_cls.parent.mkdir(parents=True, exist_ok=True)
    loose_cls.write_text("public class Loose {}", encoding="utf-8")

    discovered = service._discover_files(tmp_path)  # type: ignore[arg-type]
    assert str(loose_cls) in discovered


def test_discover_files_includes_global_value_set_and_custom_metadata_record(svc, tmp_path):
    service, _, _, _ = svc
    gvs = tmp_path / "force-app" / "main" / "default" / "globalValueSets" / "Priority.globalValueSet-meta.xml"
    cmt = tmp_path / "force-app" / "main" / "default" / "customMetadata" / "FeatureFlag.Default.md-meta.xml"
    gvs.parent.mkdir(parents=True, exist_ok=True)
    cmt.parent.mkdir(parents=True, exist_ok=True)
    gvs.write_text("<GlobalValueSet xmlns=\"http://soap.sforce.com/2006/04/metadata\"/>", encoding="utf-8")
    cmt.write_text("<CustomMetadata xmlns=\"http://soap.sforce.com/2006/04/metadata\"/>", encoding="utf-8")

    discovered = service._discover_files(tmp_path)  # type: ignore[arg-type]
    assert str(gvs) in discovered
    assert str(cmt) in discovered


@pytest.mark.asyncio
async def test_discovery_reuses_manifest_hash_when_stats_match(tmp_path):
    graph = make_mock_graph()
    manifest = make_mock_manifest()
    pool = make_mock_pool()
    service = IngestionService(
        graph=graph,
        manifest=manifest,
        pool=pool,
    )
    apex_file = tmp_path / "force-app" / "main" / "default" / "classes" / "Reuse.cls"
    apex_file.parent.mkdir(parents=True, exist_ok=True)
    apex_file.write_text("public class Reuse {}", encoding="utf-8")
    stat = apex_file.stat()
    manifest.get_tracked_files = AsyncMock(
        return_value={
            str(apex_file): {
                "sha256": "abc123",
                "size_bytes": stat.st_size,
                "mtime_ns": stat.st_mtime_ns,
                "ctime_ns": stat.st_ctime_ns,
                "status": "EDGES_WRITTEN",
            }
        }
    )

    discovered = await service._discover_file_records(tmp_path)
    assert discovered[str(apex_file)]["sha256"] == "abc123"


@pytest.mark.asyncio
async def test_discovery_rehashes_when_ctime_differs(tmp_path):
    graph = make_mock_graph()
    manifest = make_mock_manifest()
    pool = make_mock_pool()
    service = IngestionService(
        graph=graph,
        manifest=manifest,
        pool=pool,
    )
    apex_file = tmp_path / "force-app" / "main" / "default" / "classes" / "Rehash.cls"
    apex_file.parent.mkdir(parents=True, exist_ok=True)
    apex_file.write_text("public class Rehash {}", encoding="utf-8")
    stat = apex_file.stat()
    manifest.get_tracked_files = AsyncMock(
        return_value={
            str(apex_file): {
                "sha256": "stale-sha",
                "size_bytes": stat.st_size,
                "mtime_ns": stat.st_mtime_ns,
                "ctime_ns": stat.st_ctime_ns - 1,
                "status": "EDGES_WRITTEN",
            }
        }
    )

    discovered = await service._discover_file_records(tmp_path)
    assert discovered[str(apex_file)]["sha256"] != "stale-sha"


@pytest.mark.asyncio
async def test_parse_file_uses_cache_for_duplicate_content(tmp_path):
    graph = make_mock_graph()
    manifest = make_mock_manifest()
    pool = make_mock_pool()
    parse_cache = AsyncMock()
    parse_cache.get = AsyncMock(side_effect=[None, {"nodes": [], "edges": []}])
    parse_cache.put = AsyncMock(return_value=None)
    service = IngestionService(
        graph=graph,
        manifest=manifest,
        parse_cache=parse_cache,
        pool=pool,
    )
    first = tmp_path / "force-app" / "main" / "default" / "classes" / "A.cls"
    second = tmp_path / "force-app" / "main" / "default" / "classes" / "B.cls"
    first.parent.mkdir(parents=True, exist_ok=True)
    source = "public class AccountService {}"
    first.write_text(source, encoding="utf-8")
    second.write_text(source, encoding="utf-8")
    sha = "same-sha"

    await service._parse_file(str(first), sha256=sha)
    nodes, edges = await service._parse_file(str(second), sha256=sha)

    assert pool.parse.await_count == 1
    parse_cache.put.assert_awaited()
    assert nodes == []
    assert edges == []


@pytest.mark.asyncio
async def test_parse_file_uses_path_scoped_cache_for_flow_and_lwc(tmp_path):
    graph = make_mock_graph()
    manifest = make_mock_manifest()
    pool = make_mock_pool()
    parse_cache = AsyncMock()
    parse_cache.get = AsyncMock(return_value=None)
    parse_cache.put = AsyncMock(return_value=None)
    service = IngestionService(
        graph=graph,
        manifest=manifest,
        parse_cache=parse_cache,
        pool=pool,
    )

    flow_a = tmp_path / "force-app" / "main" / "default" / "flows" / "One.flow-meta.xml"
    flow_b = tmp_path / "force-app" / "main" / "default" / "flows" / "Two.flow-meta.xml"
    flow_a.parent.mkdir(parents=True, exist_ok=True)
    flow_xml = "<Flow xmlns=\"http://soap.sforce.com/2006/04/metadata\"><label>X</label><status>Active</status></Flow>"
    flow_a.write_text(flow_xml, encoding="utf-8")
    flow_b.write_text(flow_xml, encoding="utf-8")

    await service._parse_file(str(flow_a), sha256="same-sha")
    await service._parse_file(str(flow_b), sha256="same-sha")

    get_keys = [call.args[0] for call in parse_cache.get.await_args_list]
    assert len(get_keys) == 2
    assert get_keys[0] != get_keys[1]


@pytest.mark.asyncio
async def test_parse_file_uses_path_scoped_cache_for_apex_and_vlocity(tmp_path):
    graph = make_mock_graph()
    manifest = make_mock_manifest()
    pool = make_mock_pool()
    parse_cache = AsyncMock()
    parse_cache.get = AsyncMock(return_value=None)
    parse_cache.put = AsyncMock(return_value=None)
    service = IngestionService(
        graph=graph,
        manifest=manifest,
        parse_cache=parse_cache,
        pool=pool,
    )

    apex_a = tmp_path / "force-app" / "main" / "default" / "classes" / "One.cls"
    apex_b = tmp_path / "force-app" / "main" / "default" / "classes" / "Two.cls"
    apex_a.parent.mkdir(parents=True, exist_ok=True)
    source = "public class SameBody {}"
    apex_a.write_text(source, encoding="utf-8")
    apex_b.write_text(source, encoding="utf-8")

    vlocity_a = tmp_path / "vlocity" / "DataPackA_DataPack.json"
    vlocity_b = tmp_path / "vlocity" / "DataPackB_DataPack.json"
    vlocity_a.parent.mkdir(parents=True, exist_ok=True)
    datapack = '{"VlocityDataPackType":"IntegrationProcedure","Name":"Same"}'
    vlocity_a.write_text(datapack, encoding="utf-8")
    vlocity_b.write_text(datapack, encoding="utf-8")

    await service._parse_file(str(apex_a), sha256="same-apex-sha")
    await service._parse_file(str(apex_b), sha256="same-apex-sha")
    await service._parse_file(str(vlocity_a), sha256="same-vlocity-sha")
    await service._parse_file(str(vlocity_b), sha256="same-vlocity-sha")

    get_keys = [call.args[0] for call in parse_cache.get.await_args_list]
    apex_keys = [key for key in get_keys if str(key).startswith("apex@")]
    vlocity_keys = [key for key in get_keys if str(key).startswith("vlocity@")]
    assert len(apex_keys) == 2
    assert len(set(apex_keys)) == 2
    assert len(vlocity_keys) == 2
    assert len(set(vlocity_keys)) == 2


@pytest.mark.asyncio
async def test_refresh_includes_affected_neighbor_files(svc):
    service, _, manifest, _ = svc
    changed = str((Path(FIXTURE_EXPORT) / "classes" / "AccountService.cls").resolve())
    neighbor = str((Path(FIXTURE_EXPORT) / "flows" / "Simple_Account_Update.flow-meta.xml").resolve())
    manifest.get_delta = AsyncMock(
        return_value={
            "new": [changed],
            "changed": [],
            "unchanged": [],
            "deleted": [],
        }
    )
    service._nodes_for_source_files = AsyncMock(return_value={"scope::AccountService"})  # type: ignore[attr-defined]
    service._collect_neighbor_nodes = AsyncMock(return_value={"scope::Simple_Account_Update"})  # type: ignore[attr-defined]
    service._source_files_for_nodes = AsyncMock(return_value={neighbor})  # type: ignore[attr-defined]

    summary = await service.refresh(FIXTURE_EXPORT)
    assert neighbor in summary.affected_neighbor_files
    assert summary.processed_files >= 2


@pytest.mark.asyncio
async def test_ingest_writes_progress_snapshot(svc, tmp_path):
    service, _, _, _ = svc
    progress_path = tmp_path / "ingestion_progress.json"
    service._ingestion_progress_path = str(progress_path)

    await service.ingest(FIXTURE_EXPORT)

    payload = json.loads(progress_path.read_text(encoding="utf-8"))
    assert payload["available"] if "available" in payload else True
    assert payload["state"] == "completed"
    assert payload["phase"] == "completed"
    assert payload["mode"] == "full_ingest"
    assert payload["total_files"] >= 1
    assert "last_progress_at" in payload
    assert "last_job_heartbeat_at" in payload
    assert "vector_health" in payload
    assert payload["vector_health"]["enabled"] is False


@pytest.mark.asyncio
async def test_collect_facts_tracks_vlocity_outcomes(tmp_path):
    graph = make_mock_graph()
    manifest = make_mock_manifest()
    pool = make_mock_pool()
    service = IngestionService(
        graph=graph,
        manifest=manifest,
        pool=pool,
    )

    valid = tmp_path / "vlocity" / "cards" / "AccountCard_DataPack.json"
    invalid = tmp_path / "vlocity" / "cards" / "Broken_DataPack.json"
    support = tmp_path / "vlocity" / "cards" / "support.json"
    valid.parent.mkdir(parents=True, exist_ok=True)
    valid.write_text(
        json.dumps(
            {
                "VlocityDataPackType": "VlocityCard",
                "Name": "AccountCard",
                "IntegrationProcedureName": "LoadAccount",
            }
        ),
        encoding="utf-8",
    )
    invalid.write_text("{broken", encoding="utf-8")
    support.write_text(json.dumps({"name": "not-a-datapack"}), encoding="utf-8")

    _, _, _, parser_stats, _ = await service._collect_facts(
        [str(valid), str(invalid), str(support)],
        file_records=None,
    )

    assert parser_stats["vlocity"]["parsed_files"] == 1
    assert parser_stats["vlocity"]["specialized_files"] == 1
    assert parser_stats["vlocity"]["invalid_json_files"] == 1
    assert parser_stats["vlocity"]["non_datapack_json_files"] == 1
    assert parser_stats["vlocity"]["skipped_files"] == 2


def test_progress_snapshot_rejects_invalid_phase(tmp_path):
    graph = make_mock_graph()
    manifest = make_mock_manifest()
    pool = make_mock_pool()
    service = IngestionService(
        graph=graph,
        manifest=manifest,
        pool=pool,
        ingestion_progress_path=str(tmp_path / "progress.json"),
    )
    with pytest.raises(ValueError, match="Invalid ingestion phase"):
        service._write_progress_snapshot(  # noqa: SLF001
            {
                "mode": "full_ingest",
                "state": "running",
                "phase": "typo_phase",
                "total_files": 0,
                "processed_files": 0,
                "failed_files": 0,
            },
            force=True,
        )


def test_progress_snapshot_rejects_invalid_state(tmp_path):
    graph = make_mock_graph()
    manifest = make_mock_manifest()
    pool = make_mock_pool()
    service = IngestionService(
        graph=graph,
        manifest=manifest,
        pool=pool,
        ingestion_progress_path=str(tmp_path / "progress.json"),
    )
    with pytest.raises(ValueError, match="Invalid ingestion state"):
        service._write_progress_snapshot(  # noqa: SLF001
            {
                "mode": "full_ingest",
                "state": "typo_state",
                "phase": "discovering",
                "total_files": 0,
                "processed_files": 0,
                "failed_files": 0,
            },
            force=True,
        )


def test_discovery_roots_honor_sfdx_package_directories(tmp_path):
    graph = make_mock_graph()
    manifest = make_mock_manifest()
    pool = make_mock_pool()
    service = IngestionService(graph=graph, manifest=manifest, pool=pool)

    (tmp_path / "packages" / "core").mkdir(parents=True, exist_ok=True)
    (tmp_path / "packages" / "domain").mkdir(parents=True, exist_ok=True)
    (tmp_path / "vlocity").mkdir(parents=True, exist_ok=True)
    (tmp_path / "sfdx-project.json").write_text(
        json.dumps(
            {
                "packageDirectories": [
                    {"path": "packages/core"},
                    {"path": "packages/domain"},
                ]
            }
        ),
        encoding="utf-8",
    )

    roots = service._discovery_roots(tmp_path)
    root_paths = {str(path) for path in roots}
    assert str((tmp_path / "packages" / "core").resolve()) in root_paths
    assert str((tmp_path / "packages" / "domain").resolve()) in root_paths
    # Keep vlocity as a first-class discovery root even with package directories.
    assert str((tmp_path / "vlocity").resolve()) in root_paths
