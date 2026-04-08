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
async def test_query_field_population_is_strict_and_exact(svc: GraphQueryService):
    svc._vectors = AsyncMock()
    result = await svc.query("where is Status__c populated?")
    assert result["mode"] == "field_writes"
    assert result["fields"]
    assert result["fields"][0]["field"] == "Account.Status__c"
    assert result["findings"]
    assert all(finding["field"] == "Account.Status__c" for finding in result["findings"])
    assert "vector fallback disabled" in result["pipeline"]["hint"].lower()
    svc._vectors.search.assert_not_called()


@pytest.mark.asyncio
async def test_analyze_field_combines_graph_and_exact_repo_matches(tmp_path: Path):
    graph = DuckPGQStore()
    manifest = ManifestStore(str(tmp_path / "manifest_field.db"))
    await manifest.initialize()

    await graph.merge_node(
        "SFField",
        {"qualifiedName": "OrderItem.Service_Id__c"},
        {
            "qualifiedName": "OrderItem.Service_Id__c",
            "sourceFile": "objects/OrderItem/fields/Service_Id__c.field-meta.xml",
            "lineNumber": 1,
            "parserType": "xml_object",
        },
    )
    await graph.merge_node(
        "ApexClass",
        {"qualifiedName": "OrderExtensionEngine"},
        {
            "qualifiedName": "OrderExtensionEngine",
            "sourceFile": "classes/OrderExtensionEngine.cls",
            "lineNumber": 1,
            "parserType": "apex_cst",
        },
    )
    await graph.merge_edge(
        "OrderExtensionEngine",
        "ApexClass",
        "WRITES_FIELD",
        "OrderItem.Service_Id__c",
        "SFField",
        {
            "confidence": 0.96,
            "resolutionMethod": "cst",
            "edgeCategory": "DATA_FLOW",
            "contextSnippet": "orderItemEach.Service_Id__c = serviceId;",
        },
    )

    code_file = tmp_path / "force-app" / "main" / "default" / "classes" / "OrderExtensionEngine.cls"
    code_file.parent.mkdir(parents=True, exist_ok=True)
    code_file.write_text(
        "public class OrderExtensionEngine {\n"
        "  public static void apply(OrderItem orderItemEach, String serviceId) {\n"
        "    orderItemEach.Service_Id__c = serviceId;\n"
        "  }\n"
        "}\n",
        encoding="utf-8",
    )

    service = GraphQueryService(
        graph=graph,
        manifest=manifest,
        repo_root=str(tmp_path),
        ingestion_meta_path=str(tmp_path / "ingestion_meta.json"),
    )
    payload = await service.analyze_field("Service_Id__c", focus="writes")
    assert "OrderItem.Service_Id__c" in payload["resolved_fields"]
    assert payload["graph_findings"]
    assert payload["exact_matches"]
    assert any(match["file"].endswith("OrderExtensionEngine.cls") for match in payload["exact_matches"])
    await manifest.close()
    await graph.close()


@pytest.mark.asyncio
async def test_analyze_object_event_finds_matching_triggers(tmp_path: Path):
    graph = DuckPGQStore()
    manifest = ManifestStore(str(tmp_path / "manifest_trigger.db"))
    await manifest.initialize()
    trigger_file = tmp_path / "force-app" / "main" / "default" / "triggers" / "QuoteLineItemTrigger.trigger"
    trigger_file.parent.mkdir(parents=True, exist_ok=True)
    trigger_file.write_text(
        "trigger QuoteLineItemTrigger on QuoteLineItem (before insert, after insert, before update) {\n"
        "  if (Trigger.isBefore && Trigger.isInsert) {\n"
        "    QuoteLineItemTriggerHelper.processBuildersBeforeInsertCode(Trigger.new);\n"
        "  }\n"
        "  if (Trigger.isAfter && Trigger.isInsert) {\n"
        "    QuoteLineItemTriggerHelper.processAfterInsert(Trigger.new);\n"
        "  }\n"
        "}\n",
        encoding="utf-8",
    )
    service = GraphQueryService(
        graph=graph,
        manifest=manifest,
        repo_root=str(tmp_path),
        ingestion_meta_path=str(tmp_path / "ingestion_meta.json"),
    )
    payload = await service.analyze_object_event("QuoteLineItem", "insert")
    assert payload["triggers"]
    assert payload["triggers"][0]["triggerName"] == "QuoteLineItemTrigger"
    calls = payload["triggers"][0]["methodCalls"]
    assert any(call["className"] == "QuoteLineItemTriggerHelper" for call in calls)
    assert payload["important_note"]
    await manifest.close()
    await graph.close()


@pytest.mark.asyncio
async def test_analyze_component_token_traces_exact_assignments(tmp_path: Path):
    graph = DuckPGQStore()
    manifest = ManifestStore(str(tmp_path / "manifest_component.db"))
    await manifest.initialize()
    await graph.merge_node(
        "ApexClass",
        {"qualifiedName": "OrderNowUpdateAttribute"},
        {
            "qualifiedName": "OrderNowUpdateAttribute",
            "sourceFile": "force-app/main/default/classes/OrderNowUpdateAttribute.cls",
            "lineNumber": 1,
            "parserType": "apex_cst",
        },
    )
    class_file = tmp_path / "force-app" / "main" / "default" / "classes" / "OrderNowUpdateAttribute.cls"
    class_file.parent.mkdir(parents=True, exist_ok=True)
    class_file.write_text(
        "public class OrderNowUpdateAttribute {\n"
        "  public static Map<String, Object> updateAttrib(Map<String, Object> input, Id qliId) {\n"
        "    Map<String, Object> drinputMap = new Map<String, Object>();\n"
        "    drinputMap.put('accessId', qliId);\n"
        "    String accessId = (String) input.get('accessId');\n"
        "    return drinputMap;\n"
        "  }\n"
        "}\n",
        encoding="utf-8",
    )
    service = GraphQueryService(
        graph=graph,
        manifest=manifest,
        repo_root=str(tmp_path),
        ingestion_meta_path=str(tmp_path / "ingestion_meta.json"),
    )
    payload = await service.analyze_component("OrderNowUpdateAttribute", token="accessId", focus="writes")
    assert payload["resolved_components"]
    assert payload["exact_matches"]
    assert any(item["kind"] == "write" for item in payload["exact_matches"])
    assert any(item["file"].endswith("OrderNowUpdateAttribute.cls") for item in payload["exact_matches"])
    await manifest.close()
    await graph.close()


@pytest.mark.asyncio
async def test_analyze_component_falls_back_to_source_file_without_graph_node(tmp_path: Path):
    graph = DuckPGQStore()
    manifest = ManifestStore(str(tmp_path / "manifest_component_fallback.db"))
    await manifest.initialize()

    class_file = tmp_path / "force-app" / "main" / "default" / "classes" / "QuoteRecipientHelper.cls"
    class_file.parent.mkdir(parents=True, exist_ok=True)
    class_file.write_text(
        "public class QuoteRecipientHelper {\n"
        "  public static void performBeforeInsertLogic(List<QuoteLineItemRecipient> records) {\n"
        "    for (QuoteLineItemRecipient obj : records) {\n"
        "      obj.MaxDownloadSpeed = '500 Mpbs';\n"
        "    }\n"
        "  }\n"
        "}\n",
        encoding="utf-8",
    )

    service = GraphQueryService(
        graph=graph,
        manifest=manifest,
        repo_root=str(tmp_path),
        ingestion_meta_path=str(tmp_path / "ingestion_meta.json"),
    )
    payload = await service.analyze_component("QuoteRecipientHelper", token="MaxDownloadSpeed", focus="writes")

    assert payload["resolved_components"]
    assert any(str(match["file"]).endswith("QuoteRecipientHelper.cls") for match in payload["exact_matches"])
    assert any(match["kind"] == "write" for match in payload["exact_matches"])

    await manifest.close()
    await graph.close()


@pytest.mark.asyncio
async def test_analyze_component_supports_sfdx_package_directories(tmp_path: Path):
    graph = DuckPGQStore()
    manifest = ManifestStore(str(tmp_path / "manifest_component_pkg.db"))
    await manifest.initialize()

    (tmp_path / "sfdx-project.json").write_text(
        json.dumps({"packageDirectories": [{"path": "packages/sales"}]}),
        encoding="utf-8",
    )
    class_file = tmp_path / "packages" / "sales" / "main" / "default" / "classes" / "PkgHelper.cls"
    class_file.parent.mkdir(parents=True, exist_ok=True)
    class_file.write_text(
        "public class PkgHelper {\n"
        "  public static void apply(Map<String, Object> output, Id qliId) {\n"
        "    output.put('accessId', qliId);\n"
        "  }\n"
        "}\n",
        encoding="utf-8",
    )

    service = GraphQueryService(
        graph=graph,
        manifest=manifest,
        repo_root=str(tmp_path),
        ingestion_meta_path=str(tmp_path / "ingestion_meta.json"),
    )
    payload = await service.analyze_component("PkgHelper", token="accessId", focus="writes")

    assert payload["resolved_components"]
    assert any(str(match["file"]).endswith("PkgHelper.cls") for match in payload["exact_matches"])
    assert any(match["kind"] == "write" for match in payload["exact_matches"])

    await manifest.close()
    await graph.close()


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
    assert "active_run" in status


@pytest.mark.asyncio
async def test_get_ingestion_progress_returns_snapshot(tmp_path: Path):
    graph = DuckPGQStore()
    manifest = ManifestStore(str(tmp_path / "manifest_progress.db"))
    await manifest.initialize()
    progress_path = tmp_path / "ingestion_progress.json"
    progress_path.write_text(
        json.dumps(
            {
                "run_id": "run-progress-1",
                "mode": "full_ingest",
                "state": "running",
                "phase": "parsing",
                "total_files": 10,
                "processed_files": 4,
                "completion_ratio": 0.4,
            }
        ),
        encoding="utf-8",
    )
    svc = GraphQueryService(
        graph=graph,
        manifest=manifest,
        ingestion_progress_path=str(progress_path),
    )

    payload = await svc.get_ingestion_progress()
    assert payload["available"] is True
    assert payload["state"] == "running"
    assert payload["processed_files"] == 4
    assert "freshness" in payload


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
async def test_query_routes_component_token_population_to_exact_component_analysis(svc: GraphQueryService):
    svc._vectors = AsyncMock()
    payload = await svc.query("In class OSS_ServiceabilityTask, where is accessId populated? show method and source file.")
    assert payload["mode"] == "analyze_component"
    assert payload["pipeline"]["intent"] == "component_token_writes"
    assert "vector fallback disabled" in payload["pipeline"]["hint"].lower()
    svc._vectors.search.assert_not_called()


@pytest.mark.asyncio
async def test_query_routes_object_event_questions_to_event_analysis(tmp_path: Path):
    graph = DuckPGQStore()
    manifest = ManifestStore(str(tmp_path / "manifest_event_route.db"))
    await manifest.initialize()
    trigger_file = tmp_path / "force-app" / "main" / "default" / "triggers" / "QuoteLineItemTrigger.trigger"
    trigger_file.parent.mkdir(parents=True, exist_ok=True)
    trigger_file.write_text(
        "trigger QuoteLineItemTrigger on QuoteLineItem (before insert, after insert) {\n"
        "  if (Trigger.isBefore && Trigger.isInsert) {\n"
        "    QuoteLineItemTriggerHelper.populateFields(Trigger.new);\n"
        "  }\n"
        "}\n",
        encoding="utf-8",
    )
    service = GraphQueryService(
        graph=graph,
        manifest=manifest,
        repo_root=str(tmp_path),
        ingestion_meta_path=str(tmp_path / "ingestion_meta.json"),
    )
    payload = await service.query("what happens when a QuoteLineItem is inserted?")
    assert payload["mode"] == "analyze_object_event"
    assert payload["event"] == "insert"
    assert payload["triggers"]
    assert payload["pipeline"]["intent"] == "object_event"
    await manifest.close()
    await graph.close()


@pytest.mark.asyncio
async def test_analyze_change_resolves_component_to_source_files(svc: GraphQueryService):
    payload = await svc.analyze_change(target="AccountService", max_hops=2, max_results_per_component=10)
    assert payload["mode"] == "analyze_change"
    assert payload["target_resolution"]["mode"] == "component_target"
    assert payload["analysis"]["changed_files"]
    assert any(path.endswith("AccountService.cls") for path in payload["analysis"]["changed_files"])


@pytest.mark.asyncio
async def test_query_routes_change_questions_to_analyze_change(svc: GraphQueryService):
    payload = await svc.query("what breaks if I change AccountService?")
    assert payload["mode"] == "analyze_change"
    assert payload["pipeline"]["intent"] == "analyze_change"
    assert payload["target_resolution"]["mode"] in {"component_target", "file_target"}


@pytest.mark.asyncio
async def test_analyze_exact_routes_to_field_analysis(svc: GraphQueryService):
    payload = await svc.analyze("where is Status__c populated?", mode="exact", strict=True)
    assert payload["mode"] == "analyze"
    assert payload["analysis_mode"] == "exact"
    assert payload["routed_to"] == "analyze_field"
    assert payload["result"]["mode"] == "analyze_field"
    assert payload["evidence"]


@pytest.mark.asyncio
async def test_analyze_lineage_routes_to_object_event(tmp_path: Path):
    graph = DuckPGQStore()
    manifest = ManifestStore(str(tmp_path / "manifest_analyze_lineage.db"))
    await manifest.initialize()
    trigger_file = tmp_path / "force-app" / "main" / "default" / "triggers" / "QuoteLineItemTrigger.trigger"
    trigger_file.parent.mkdir(parents=True, exist_ok=True)
    trigger_file.write_text(
        "trigger QuoteLineItemTrigger on QuoteLineItem (before insert, after insert) {\n"
        "  if (Trigger.isBefore && Trigger.isInsert) {\n"
        "    QuoteLineItemTriggerHelper.populateFields(Trigger.new);\n"
        "  }\n"
        "}\n",
        encoding="utf-8",
    )
    service = GraphQueryService(
        graph=graph,
        manifest=manifest,
        repo_root=str(tmp_path),
        ingestion_meta_path=str(tmp_path / "ingestion_meta.json"),
    )
    payload = await service.analyze("what happens when a QuoteLineItem is inserted?", mode="lineage")
    assert payload["mode"] == "analyze"
    assert payload["analysis_mode"] == "lineage"
    assert payload["routed_to"] == "analyze_object_event"
    assert payload["result"]["mode"] == "analyze_object_event"
    await manifest.close()
    await graph.close()


@pytest.mark.asyncio
async def test_analyze_exact_disables_vector_fallback_for_unresolved_queries(tmp_path: Path):
    graph = DuckPGQStore()
    manifest = ManifestStore(str(tmp_path / "manifest_analyze_exact_no_vector.db"))
    await manifest.initialize()
    vectors = AsyncMock()
    vectors.search = AsyncMock(
        return_value=[
            {
                "node_id": "scope::ApexClass:Fallback",
                "score": 0.88,
                "payload": {"label": "ApexClass", "sourceFile": "classes/Fallback.cls"},
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
    payload = await service.analyze("find nonexistingthing", mode="exact", strict=True, max_results=10)
    assert payload["mode"] == "analyze"
    assert payload["analysis_mode"] == "exact"
    assert payload["result"]["mode"] == "node_search"
    assert payload["result"]["candidates"] == []
    assert "vector fallback disabled" in payload["result"]["pipeline"]["hint"].lower()
    vectors.search.assert_not_called()
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
