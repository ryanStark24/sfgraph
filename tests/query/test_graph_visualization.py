from __future__ import annotations

from pathlib import Path

import pytest

from sfgraph.query.graph_query_service import GraphQueryService
from sfgraph.storage.duckpgq_store import DuckPGQStore
from sfgraph.storage.manifest_store import ManifestStore


@pytest.mark.asyncio
async def test_graph_subgraph_renders_mermaid(tmp_path: Path):
    graph = DuckPGQStore()
    manifest = ManifestStore(str(tmp_path / "manifest.db"))
    await manifest.initialize()
    await graph.merge_node("ApexClass", {"qualifiedName": "AccountService"}, {"qualifiedName": "AccountService", "sourceFile": "classes/AccountService.cls"})
    await graph.merge_node("SFField", {"qualifiedName": "Account.Status__c"}, {"qualifiedName": "Account.Status__c", "sourceFile": "objects/Account/fields/Status__c.field-meta.xml"})
    await graph.merge_edge(
        "AccountService",
        "ApexClass",
        "WRITES_FIELD",
        "Account.Status__c",
        "SFField",
        {"confidence": 0.9, "resolutionMethod": "cst", "edgeCategory": "DATA_FLOW", "contextSnippet": "acc.Status__c = 'Active';"},
    )

    service = GraphQueryService(
        graph=graph,
        manifest=manifest,
        vectors=None,
        repo_root=str(tmp_path),
        ingestion_meta_path=str(tmp_path / "ingestion_meta.json"),
        ingestion_progress_path=str(tmp_path / "ingestion_progress.json"),
    )
    payload = await service.graph_subgraph(node_id="AccountService", format="mermaid")

    assert payload["format"] == "mermaid"
    assert "graph TD" in payload["mermaid"]
    assert "WRITES_FIELD" in payload["mermaid"]

    await manifest.close()
    await graph.close()


@pytest.mark.asyncio
async def test_export_diagnostics_md_writes_markdown(tmp_path: Path):
    graph = DuckPGQStore()
    manifest = ManifestStore(str(tmp_path / "manifest.db"))
    await manifest.initialize()
    (tmp_path / "ingestion_meta.json").write_text('{"run_id":"r1","export_dir":"/tmp/repo","parser_stats":{"vlocity":{"parsed_files":4}}}', encoding="utf-8")
    (tmp_path / "ingestion_progress.json").write_text('{"state":"running","phase":"parsing"}', encoding="utf-8")

    service = GraphQueryService(
        graph=graph,
        manifest=manifest,
        vectors=None,
        repo_root=str(tmp_path),
        ingestion_meta_path=str(tmp_path / "ingestion_meta.json"),
        ingestion_progress_path=str(tmp_path / "ingestion_progress.json"),
    )
    payload = await service.export_diagnostics_md()

    assert payload["path"].endswith("ingestion_diagnostics.md")
    assert Path(payload["path"]).exists()
    assert "Ingestion Diagnostics" in Path(payload["path"]).read_text(encoding="utf-8")

    await manifest.close()
    await graph.close()
