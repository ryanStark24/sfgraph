"""Utilities to migrate legacy unscoped graph rows to project-scoped keys."""
from __future__ import annotations

import hashlib
import json
from pathlib import Path
from typing import Any

from sfgraph.storage.base import GraphStore
from sfgraph.storage.vector_store import VectorStore


def _parse_props(value: Any) -> dict[str, Any]:
    if isinstance(value, dict):
        return value
    if isinstance(value, str):
        try:
            parsed = json.loads(value)
            if isinstance(parsed, dict):
                return parsed
        except Exception:
            return {}
    return {}


class ScopeMigrationService:
    """Migrate graph entities from legacy unscoped keys to project scope keys."""

    def __init__(self, graph: GraphStore, vectors: VectorStore | None = None) -> None:
        self._graph = graph
        self._vectors = vectors

    @staticmethod
    def compute_scope(export_dir: str) -> str:
        resolved = str(Path(export_dir).expanduser().resolve())
        return hashlib.sha1(resolved.encode("utf-8")).hexdigest()[:12]

    @staticmethod
    def _scoped_qname(scope: str, qname: str) -> str:
        if "::" in qname:
            return qname
        return f"{scope}::{qname}"

    @staticmethod
    def _source_in_export(source_file: str | None, export_root: Path) -> bool:
        if not source_file:
            return False
        try:
            path = Path(source_file).expanduser().resolve()
            return path == export_root or export_root in path.parents
        except Exception:
            return False

    async def migrate_project_scope(
        self,
        export_dir: str,
        dry_run: bool = False,
        prune_legacy: bool = False,
    ) -> dict[str, Any]:
        export_root = Path(export_dir).expanduser().resolve()
        scope = self.compute_scope(str(export_root))
        labels = await self._graph.get_labels()
        rel_types = await self._graph.get_relationship_types()

        qname_to_label: dict[str, str] = {}
        for label in labels:
            try:
                rows = await self._graph.query(f'SELECT qualified_name FROM "{label}"')
            except Exception:
                rows = []
            for row in rows:
                qn = str(row.get("qualified_name", ""))
                if qn:
                    qname_to_label[qn] = label

        node_map: dict[str, str] = {}
        migrated_nodes = 0
        skipped_nodes = 0

        for label in labels:
            try:
                rows = await self._graph.query(f'SELECT qualified_name, props FROM "{label}"')
            except Exception:
                rows = []
            for row in rows:
                old_qn = str(row.get("qualified_name", ""))
                if not old_qn:
                    continue
                if "::" in old_qn:
                    skipped_nodes += 1
                    continue
                props = _parse_props(row.get("props"))
                if not self._source_in_export(props.get("sourceFile"), export_root):
                    skipped_nodes += 1
                    continue

                new_qn = self._scoped_qname(scope, old_qn)
                node_map[old_qn] = new_qn
                qname_to_label[new_qn] = label
                migrated_nodes += 1

                if dry_run:
                    continue

                migrated_props = dict(props)
                migrated_props["qualifiedName"] = old_qn
                migrated_props["scopedQualifiedName"] = new_qn
                migrated_props["projectScope"] = scope
                await self._graph.merge_node(
                    label,
                    {"qualifiedName": new_qn},
                    migrated_props,
                )
                await self._graph.query(
                    f'DELETE FROM "{label}" WHERE qualified_name = $qn',
                    {"qn": old_qn},
                )

        migrated_edges = 0
        skipped_edges = 0
        pruned_legacy_edges = 0

        for rel in rel_types:
            try:
                rows = await self._graph.query(
                    f'SELECT src_qualified_name, dst_qualified_name, props FROM "{rel}"'
                )
            except Exception:
                rows = []
            for row in rows:
                src = str(row.get("src_qualified_name", ""))
                dst = str(row.get("dst_qualified_name", ""))
                if not src or not dst:
                    continue

                src_new = node_map.get(src)
                dst_new = node_map.get(dst)
                should_migrate = bool(src_new or dst_new)
                if not should_migrate:
                    if prune_legacy and ("::" not in src or "::" not in dst):
                        # Prune legacy mixed/unscoped edge.
                        pruned_legacy_edges += 1
                        if not dry_run:
                            await self._graph.query(
                                f'DELETE FROM "{rel}" WHERE src_qualified_name = $src AND dst_qualified_name = $dst',
                                {"src": src, "dst": dst},
                            )
                    else:
                        skipped_edges += 1
                    continue

                new_src = src_new or src
                new_dst = dst_new or dst
                props = _parse_props(row.get("props"))
                props["projectScope"] = scope
                migrated_edges += 1

                if dry_run:
                    continue

                await self._graph.merge_edge(
                    new_src,
                    qname_to_label.get(new_src, "Unknown"),
                    rel,
                    new_dst,
                    qname_to_label.get(new_dst, "Unknown"),
                    props,
                )
                await self._graph.query(
                    f'DELETE FROM "{rel}" WHERE src_qualified_name = $src AND dst_qualified_name = $dst',
                    {"src": src, "dst": dst},
                )

        # Optional prune of remaining legacy nodes under export path.
        pruned_legacy_nodes = 0
        if prune_legacy:
            for label in labels:
                try:
                    rows = await self._graph.query(f'SELECT qualified_name, props FROM "{label}"')
                except Exception:
                    rows = []
                for row in rows:
                    qn = str(row.get("qualified_name", ""))
                    if not qn or "::" in qn:
                        continue
                    props = _parse_props(row.get("props"))
                    if not self._source_in_export(props.get("sourceFile"), export_root):
                        continue
                    pruned_legacy_nodes += 1
                    if not dry_run:
                        await self._graph.query(
                            f'DELETE FROM "{label}" WHERE qualified_name = $qn',
                            {"qn": qn},
                        )

        if self._vectors and not dry_run and scope:
            # Drop stale vectors for this scope and rely on fresh ingest/refresh to rebuild.
            await self._vectors.delete_by_project_scope(scope)

        return {
            "export_dir": str(export_root),
            "project_scope": scope,
            "dry_run": dry_run,
            "migrated_nodes": migrated_nodes,
            "migrated_edges": migrated_edges,
            "skipped_nodes": skipped_nodes,
            "skipped_edges": skipped_edges,
            "pruned_legacy_nodes": pruned_legacy_nodes,
            "pruned_legacy_edges": pruned_legacy_edges,
        }
