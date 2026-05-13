"""Tests for graph snapshot create/diff features."""
from __future__ import annotations

from pathlib import Path

import pytest

from sfgraph.ingestion.snapshot import GraphSnapshotService
from sfgraph.storage.duckpgq_store import DuckPGQStore


@pytest.mark.asyncio
async def test_create_snapshot_writes_json(tmp_path: Path):
    graph = DuckPGQStore()
    await graph.merge_node(
        "ApexClass",
        {"qualifiedName": "AccountService"},
        {"qualifiedName": "AccountService", "sourceFile": "classes/AccountService.cls"},
    )
    await graph.merge_node(
        "SFField",
        {"qualifiedName": "Account.Status__c"},
        {"qualifiedName": "Account.Status__c", "sourceFile": "objects/Account.object-meta.xml"},
    )
    await graph.merge_edge(
        "AccountService",
        "ApexClass",
        "READS_FIELD",
        "Account.Status__c",
        "SFField",
        {"confidence": 0.9, "resolutionMethod": "cst", "edgeCategory": "DATA_FLOW"},
    )

    service = GraphSnapshotService(graph=graph, snapshot_dir=str(tmp_path))
    result = await service.create_snapshot(name="baseline")
    assert result["snapshot_name"] == "baseline"
    assert result["node_count"] == 2
    assert result["edge_count"] == 1
    assert (tmp_path / "baseline.json").exists()

    await graph.close()


@pytest.mark.asyncio
async def test_diff_snapshots_detects_added_and_changed(tmp_path: Path):
    graph = DuckPGQStore()
    service = GraphSnapshotService(graph=graph, snapshot_dir=str(tmp_path))

    await graph.merge_node(
        "ApexClass",
        {"qualifiedName": "AccountService"},
        {"qualifiedName": "AccountService", "sourceFile": "classes/AccountService.cls"},
    )
    left = await service.create_snapshot(name="left")

    await graph.merge_node(
        "ApexClass",
        {"qualifiedName": "AccountService"},
        {"qualifiedName": "AccountService", "sourceFile": "classes/NewAccountService.cls"},
    )
    await graph.merge_node(
        "ApexClass",
        {"qualifiedName": "AccountHelper"},
        {"qualifiedName": "AccountHelper", "sourceFile": "classes/AccountHelper.cls"},
    )
    right = await service.create_snapshot(name="right")

    diff = GraphSnapshotService.diff_snapshots(
        snapshot_a_path=left["snapshot_path"],
        snapshot_b_path=right["snapshot_path"],
    )
    assert diff["counts"]["added_nodes"] == 1
    assert diff["counts"]["changed_nodes"] == 1
    assert diff["examples"]["added_nodes"][0]["qualified_name"] == "AccountHelper"

    await graph.close()
