"""Tests for GraphQueryService lineage/query/freshness behaviors."""
from __future__ import annotations

import json
from pathlib import Path
from unittest.mock import AsyncMock

import pytest

from sfgraph.query.graph_query_service import GraphQueryService
from sfgraph.storage.duckpgq_store import DuckPGQStore
from sfgraph.storage.manifest_store import ManifestStore


@pytest.fixture
async def svc(tmp_path: Path):
    graph = DuckPGQStore()
    manifest = ManifestStore(str(tmp_path / "manifest.db"))
    await manifest.initialize()

    await graph.merge_node(
        "SFField",
        {"qualifiedName": "Account.Status__c"},
        {
            "qualifiedName": "Account.Status__c",
            "sourceFile": "objects/Account/fields/Status__c.field-meta.xml",
            "lineNumber": 12,
            "parserType": "xml_object",
        },
    )
    await graph.merge_node(
        "ApexClass",
        {"qualifiedName": "AccountService"},
        {
            "qualifiedName": "AccountService",
            "sourceFile": "classes/AccountService.cls",
            "lineNumber": 5,
            "parserType": "apex_cst",
        },
    )
    await graph.merge_node(
        "ApexClass",
        {"qualifiedName": "AccountHelper"},
        {
            "qualifiedName": "AccountHelper",
            "sourceFile": "classes/AccountHelper.cls",
            "lineNumber": 8,
            "parserType": "apex_cst",
        },
    )
    await graph.merge_node(
        "Flow",
        {"qualifiedName": "UpdateAccountFlow"},
        {
            "qualifiedName": "UpdateAccountFlow",
            "sourceFile": "flows/UpdateAccountFlow.flow-meta.xml",
            "lineNumber": 0,
            "parserType": "xml_flow",
        },
    )
    await graph.merge_node(
        "LWCComponent",
        {"qualifiedName": "AccountPanel"},
        {
            "qualifiedName": "AccountPanel",
            "sourceFile": "lwc/accountPanel/accountPanel.js",
            "lineNumber": 3,
            "parserType": "lwc_js",
        },
    )
    await graph.merge_node(
        "DataRaptor",
        {"qualifiedName": "AccountUpdateDR"},
        {
            "qualifiedName": "AccountUpdateDR",
            "sourceFile": "vlocity/DataRaptor/AccountUpdateDR.json",
            "lineNumber": 1,
            "parserType": "vlocity",
        },
    )

    await graph.merge_edge(
        "AccountService",
        "ApexClass",
        "READS_FIELD",
        "Account.Status__c",
        "SFField",
        {
            "confidence": 0.9,
            "resolutionMethod": "cst",
            "edgeCategory": "DATA_FLOW",
            "contextSnippet": "acc.Status__c",
        },
    )
    await graph.merge_edge(
        "AccountHelper",
        "ApexClass",
        "READS_FIELD",
        "Account.Status__c",
        "SFField",
        {
            "confidence": 0.8,
            "resolutionMethod": "cst",
            "edgeCategory": "DATA_FLOW",
            "contextSnippet": "helper reads status",
        },
    )
    await graph.merge_edge(
        "UpdateAccountFlow",
        "Flow",
        "FLOW_WRITES_FIELD",
        "Account.Status__c",
        "SFField",
        {
            "confidence": 0.95,
            "resolutionMethod": "direct",
            "edgeCategory": "DATA_FLOW",
            "contextSnippet": "Update_Account_Status",
        },
    )
    await graph.merge_edge(
        "AccountPanel",
        "LWCComponent",
        "TRIGGERS_FLOW",
        "UpdateAccountFlow",
        "Flow",
        {
            "confidence": 0.7,
            "resolutionMethod": "direct",
            "edgeCategory": "CONTROL_FLOW",
            "contextSnippet": "launch flow",
        },
    )
    await graph.merge_edge(
        "UpdateAccountFlow",
        "Flow",
        "FLOW_CALLS_APEX",
        "AccountService",
        "ApexClass",
        {
            "confidence": 0.9,
            "resolutionMethod": "direct",
            "edgeCategory": "CONTROL_FLOW",
            "contextSnippet": "invoke invocable apex",
        },
    )
    await graph.merge_edge(
        "UpdateAccountFlow",
        "Flow",
        "FLOW_CALLS_DR",
        "AccountUpdateDR",
        "DataRaptor",
        {
            "confidence": 0.8,
            "resolutionMethod": "direct",
            "edgeCategory": "DATA_FLOW",
            "contextSnippet": "dataraptor action",
        },
    )
    await graph.merge_edge(
        "AccountService",
        "ApexClass",
        "READS_FIELD",
        "UNRESOLVED.Dynamic.Account.Status__c",
        "SFField",
        {
            "confidence": 0.4,
            "resolutionMethod": "dynamic",
            "edgeCategory": "DATA_FLOW",
            "contextSnippet": "Database.query(dynamicSoql)",
        },
    )

    run_id = await manifest.create_run()
    file_a = str(tmp_path / "classes" / "AccountService.cls")
    file_b = str(tmp_path / "flows" / "UpdateAccountFlow.flow-meta.xml")
    Path(file_a).parent.mkdir(parents=True, exist_ok=True)
    Path(file_b).parent.mkdir(parents=True, exist_ok=True)
    Path(file_a).write_text("class A {}", encoding="utf-8")
    Path(file_b).write_text("<Flow></Flow>", encoding="utf-8")

    await manifest.upsert_file(file_a, ManifestStore.compute_sha256(file_a), run_id)
    await manifest.upsert_file(file_b, ManifestStore.compute_sha256(file_b), run_id)
    await manifest.set_status(file_a, "EDGES_WRITTEN")
    await manifest.set_status(file_b, "NODES_WRITTEN")
    await manifest.mark_run_complete(run_id, phase_1_complete=True, phase_2_complete=False)

    meta_path = tmp_path / "ingestion_meta.json"
    meta_path.write_text(
        json.dumps(
            {
                "run_id": run_id,
                "indexed_commit": "abc123",
                "indexed_at": "2026-04-06T00:00:00Z",
                "parser_stats": {"apex": {"parsed_files": 10, "error_files": 1, "skipped_files": 0}},
                "unresolved_symbols": 3,
            }
        ),
        encoding="utf-8",
    )

    service = GraphQueryService(
        graph=graph,
        manifest=manifest,
        repo_root=str(tmp_path),
        ingestion_meta_path=str(meta_path),
    )

    yield service

    await manifest.close()
    await graph.close()


@pytest.mark.asyncio
async def test_trace_upstream_returns_evidence_and_freshness(svc: GraphQueryService):
    result = await svc.trace_upstream("Account.Status__c", max_hops=2, max_results=10)
    assert result["findings"]
    first_path = result["findings"][0]["path"]
    assert first_path
    step = first_path[0]
    assert "contextSnippet" in step
    assert "confidence" in step
    assert "semantic" in step
    assert "source_file" in step
    assert "source_line" in step

    freshness = result["freshness"]
    assert freshness["indexed_commit"] == "abc123"
    assert freshness["dirty_files_pending"] >= 1


@pytest.mark.asyncio
async def test_trace_respects_result_limit_and_sets_partial(svc: GraphQueryService):
    result = await svc.trace_upstream("Account.Status__c", max_hops=2, max_results=1)
    assert len(result["findings"]) == 1
    assert result["partial_results"] is True


@pytest.mark.asyncio
async def test_query_dispatches_to_trace_upstream(svc: GraphQueryService):
    result = await svc.query("what uses Account.Status__c?")
    assert result["mode"] == "trace_upstream"
    assert result["findings"]
    assert "pipeline" in result
    assert "confidence_tiers" in result


@pytest.mark.asyncio
async def test_get_node_returns_adjacent_edges(svc: GraphQueryService):
    payload = await svc.get_node("Account.Status__c")
    assert payload["node"] is not None
    assert payload["incoming_edges"]


@pytest.mark.asyncio
async def test_explain_field_returns_reader_writer_views(svc: GraphQueryService):
    payload = await svc.explain_field("Account.Status__c")
    assert payload["readers"]
    assert isinstance(payload["writers"], list)
    assert "freshness" in payload


@pytest.mark.asyncio
async def test_get_ingestion_status_contract(svc: GraphQueryService):
    status = await svc.get_ingestion_status()
    assert "node_counts_by_type" in status
    assert "edge_counts_by_type" in status
    assert "status_counts" in status
    assert "dirty_files_pending" in status
    assert "parser_stats" in status
    assert status["unresolved_symbols"] == 3
    assert "freshness" in status


@pytest.mark.asyncio
async def test_impact_from_changed_files_returns_risk_and_components(svc: GraphQueryService):
    payload = await svc.impact_from_changed_files(
        changed_files=["classes/AccountService.cls"],
        max_hops=2,
        max_results_per_component=10,
    )
    assert payload["changed_files"]
    assert "risk_level" in payload
    assert payload["risk_level"] in {"low", "medium", "high"}
    assert payload["impacted_components"]
    assert "test_gap_areas" in payload
    assert "test_intelligence" in payload
    assert "coverage_ratio" in payload["test_intelligence"]


@pytest.mark.asyncio
async def test_cross_layer_flow_map_returns_layered_paths(svc: GraphQueryService):
    payload = await svc.cross_layer_flow_map("AccountPanel", max_hops=4, max_results=20)
    assert payload["mode"] == "cross_layer_flow_map"
    assert payload["layer_paths"]
    first_layers = payload["layer_paths"][0]["layers"]
    assert "UI" in first_layers
    assert "FLOW" in first_layers


@pytest.mark.asyncio
async def test_list_unknown_dynamic_edges_returns_unresolved(svc: GraphQueryService):
    payload = await svc.list_unknown_dynamic_edges(limit=20)
    assert payload["count"] >= 1
    assert payload["findings"][0]["resolutionMethod"] in {"dynamic", "unknown", "regex", "traced_limit"}


@pytest.mark.asyncio
async def test_query_resolves_alias_via_rules(tmp_path: Path):
    graph = DuckPGQStore()
    manifest = ManifestStore(str(tmp_path / "manifest_rules.db"))
    await manifest.initialize()
    await graph.merge_node(
        "SFField",
        {"qualifiedName": "Account.Status__c"},
        {
            "qualifiedName": "Account.Status__c",
            "sourceFile": "objects/Account/fields/Status__c.field-meta.xml",
            "lineNumber": 12,
            "parserType": "xml_object",
        },
    )
    (tmp_path / "rules.yaml").write_text(
        "aliases:\n  status_alias: Account.Status__c\n",
        encoding="utf-8",
    )
    service = GraphQueryService(
        graph=graph,
        manifest=manifest,
        repo_root=str(tmp_path),
        ingestion_meta_path=str(tmp_path / "ingestion_meta_unused.json"),
        rules_path=str(tmp_path / "rules.yaml"),
    )
    payload = await service.query("find status_alias")
    assert payload["mode"] == "node_search"
    assert payload["candidates"]
    assert payload["pipeline"]["attempts"]
    await manifest.close()
    await graph.close()


@pytest.mark.asyncio
async def test_scope_isolation_filters_other_project_nodes(tmp_path: Path):
    graph = DuckPGQStore()
    manifest = ManifestStore(str(tmp_path / "manifest_scope.db"))
    await manifest.initialize()

    scope_a = "scopeaaaa1111"
    scope_b = "scopebbbb2222"

    await graph.merge_node(
        "SFField",
        {"qualifiedName": f"{scope_a}::Account.Status__c"},
        {
            "qualifiedName": "Account.Status__c",
            "scopedQualifiedName": f"{scope_a}::Account.Status__c",
            "projectScope": scope_a,
            "sourceFile": "a/Status.field-meta.xml",
            "lineNumber": 1,
            "parserType": "xml_object",
        },
    )
    await graph.merge_node(
        "ApexClass",
        {"qualifiedName": f"{scope_a}::AccountService"},
        {
            "qualifiedName": "AccountService",
            "scopedQualifiedName": f"{scope_a}::AccountService",
            "projectScope": scope_a,
            "sourceFile": "a/AccountService.cls",
            "lineNumber": 1,
            "parserType": "apex_cst",
        },
    )
    await graph.merge_edge(
        f"{scope_a}::AccountService",
        "ApexClass",
        "READS_FIELD",
        f"{scope_a}::Account.Status__c",
        "SFField",
        {
            "confidence": 0.9,
            "resolutionMethod": "cst",
            "edgeCategory": "DATA_FLOW",
            "contextSnippet": "a scope read",
            "projectScope": scope_a,
        },
    )

    await graph.merge_node(
        "SFField",
        {"qualifiedName": f"{scope_b}::Account.Status__c"},
        {
            "qualifiedName": "Account.Status__c",
            "scopedQualifiedName": f"{scope_b}::Account.Status__c",
            "projectScope": scope_b,
            "sourceFile": "b/Status.field-meta.xml",
            "lineNumber": 1,
            "parserType": "xml_object",
        },
    )
    await graph.merge_node(
        "ApexClass",
        {"qualifiedName": f"{scope_b}::OtherService"},
        {
            "qualifiedName": "OtherService",
            "scopedQualifiedName": f"{scope_b}::OtherService",
            "projectScope": scope_b,
            "sourceFile": "b/OtherService.cls",
            "lineNumber": 1,
            "parserType": "apex_cst",
        },
    )
    await graph.merge_edge(
        f"{scope_b}::OtherService",
        "ApexClass",
        "READS_FIELD",
        f"{scope_b}::Account.Status__c",
        "SFField",
        {
            "confidence": 0.8,
            "resolutionMethod": "cst",
            "edgeCategory": "DATA_FLOW",
            "contextSnippet": "b scope read",
            "projectScope": scope_b,
        },
    )

    meta_path = tmp_path / "ingestion_meta_scope.json"
    meta_path.write_text(
        json.dumps(
            {
                "project_scope": scope_a,
                "indexed_commit": "abc123",
                "indexed_at": "2026-04-06T00:00:00Z",
            }
        ),
        encoding="utf-8",
    )

    service = GraphQueryService(
        graph=graph,
        manifest=manifest,
        repo_root=str(tmp_path),
        ingestion_meta_path=str(meta_path),
    )

    trace = await service.trace_upstream("Account.Status__c", max_hops=2, max_results=10)
    assert trace["findings"]
    targets = {finding["target_node"] for finding in trace["findings"]}
    assert "AccountService" in targets
    assert "OtherService" not in targets

    search = await service.query("find Account.Status__c")
    candidate_names = {item["qualifiedName"] for item in search["candidates"]}
    assert "Account.Status__c" in candidate_names
    assert len(search["candidates"]) == 1

    await manifest.close()
    await graph.close()


@pytest.mark.asyncio
async def test_query_uses_vector_fallback_when_no_lexical_hits(tmp_path: Path):
    graph = DuckPGQStore()
    manifest = ManifestStore(str(tmp_path / "manifest_vec.db"))
    await manifest.initialize()
    vectors = AsyncMock()
    vectors.search = AsyncMock(
        return_value=[
            {
                "node_id": "scope::ApexClass:AccountService",
                "score": 0.88,
                "payload": {"label": "ApexClass", "sourceFile": "classes/AccountService.cls"},
            }
        ]
    )
    service = GraphQueryService(
        graph=graph,
        manifest=manifest,
        vectors=vectors,
        repo_root=str(tmp_path),
        ingestion_meta_path=str(tmp_path / "meta_vec.json"),
    )
    payload = await service.query("show me account service logic")
    assert payload["mode"] == "node_search"
    assert payload["candidates"]
    assert "vector fallback" in payload["pipeline"]["hint"].lower()
    assert payload["pipeline"]["agent_trace"]
    await manifest.close()
    await graph.close()


@pytest.mark.asyncio
async def test_test_gap_intelligence_from_changed_files(svc: GraphQueryService):
    payload = await svc.test_gap_intelligence_from_changed_files(
        changed_files=["classes/AccountService.cls"],
        max_hops=2,
        max_results_per_component=10,
    )
    assert "test_intelligence" in payload
    ti = payload["test_intelligence"]
    assert "coverage_by_component" in ti
    assert "coverage_ratio" in ti
