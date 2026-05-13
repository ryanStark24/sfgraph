"""Tests for legacy scope migration utilities."""
from __future__ import annotations

from pathlib import Path

import pytest

from sfgraph.ingestion.scope_migration import ScopeMigrationService
from sfgraph.storage.duckpgq_store import DuckPGQStore


@pytest.mark.asyncio
async def test_migrate_project_scope_dry_run_counts(tmp_path: Path):
    export_dir = tmp_path / "metadata"
    export_dir.mkdir(parents=True, exist_ok=True)
    source_file = export_dir / "classes" / "AccountService.cls"
    source_file.parent.mkdir(parents=True, exist_ok=True)
    source_file.write_text("class A {}", encoding="utf-8")

    graph = DuckPGQStore()
    await graph.merge_node(
        "ApexClass",
        {"qualifiedName": "AccountService"},
        {"qualifiedName": "AccountService", "sourceFile": str(source_file)},
    )
    await graph.merge_node(
        "SFField",
        {"qualifiedName": "Account.Status__c"},
        {"qualifiedName": "Account.Status__c", "sourceFile": str(source_file)},
    )
    await graph.merge_edge(
        "AccountService",
        "ApexClass",
        "READS_FIELD",
        "Account.Status__c",
        "SFField",
        {"confidence": 0.9, "resolutionMethod": "cst", "edgeCategory": "DATA_FLOW"},
    )

    service = ScopeMigrationService(graph=graph)
    result = await service.migrate_project_scope(str(export_dir), dry_run=True, prune_legacy=False)
    assert result["migrated_nodes"] == 2
    assert result["migrated_edges"] == 1

    # Dry run should not modify existing rows.
    rows = await graph.query('SELECT qualified_name FROM "ApexClass"')
    assert rows[0]["qualified_name"] == "AccountService"
    await graph.close()


@pytest.mark.asyncio
async def test_migrate_project_scope_applies_scope_and_prunes(tmp_path: Path):
    export_dir = tmp_path / "metadata"
    export_dir.mkdir(parents=True, exist_ok=True)
    source_file = export_dir / "classes" / "AccountService.cls"
    source_file.parent.mkdir(parents=True, exist_ok=True)
    source_file.write_text("class A {}", encoding="utf-8")

    outside_file = tmp_path / "outside" / "Other.cls"
    outside_file.parent.mkdir(parents=True, exist_ok=True)
    outside_file.write_text("class B {}", encoding="utf-8")

    graph = DuckPGQStore()
    await graph.merge_node(
        "ApexClass",
        {"qualifiedName": "AccountService"},
        {"qualifiedName": "AccountService", "sourceFile": str(source_file)},
    )
    await graph.merge_node(
        "ApexClass",
        {"qualifiedName": "OtherService"},
        {"qualifiedName": "OtherService", "sourceFile": str(outside_file)},
    )
    await graph.merge_edge(
        "AccountService",
        "ApexClass",
        "CALLS",
        "OtherService",
        "ApexClass",
        {"confidence": 0.8, "resolutionMethod": "cst", "edgeCategory": "CONTROL_FLOW"},
    )

    service = ScopeMigrationService(graph=graph)
    result = await service.migrate_project_scope(str(export_dir), dry_run=False, prune_legacy=True)
    scope = result["project_scope"]
    assert result["migrated_nodes"] == 1
    assert result["migrated_edges"] == 1

    apex_rows = await graph.query('SELECT qualified_name, props FROM "ApexClass"')
    qnames = {row["qualified_name"] for row in apex_rows}
    assert f"{scope}::AccountService" in qnames
    assert "AccountService" not in qnames
    assert "OtherService" in qnames  # untouched outside export root

    edge_rows = await graph.query('SELECT src_qualified_name, dst_qualified_name FROM "CALLS"')
    assert edge_rows
    assert edge_rows[0]["src_qualified_name"] == f"{scope}::AccountService"
    assert edge_rows[0]["dst_qualified_name"] == "OtherService"
    await graph.close()
