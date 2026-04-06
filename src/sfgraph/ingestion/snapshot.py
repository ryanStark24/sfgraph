"""Graph snapshot creation and diff utilities."""
from __future__ import annotations

import json
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from sfgraph.storage.base import GraphStore


def _parse_props(value: Any) -> dict[str, Any]:
    if isinstance(value, dict):
        return value
    if isinstance(value, str):
        try:
            payload = json.loads(value)
            if isinstance(payload, dict):
                return payload
        except Exception:
            return {}
    return {}


def _stable_json(value: dict[str, Any]) -> str:
    return json.dumps(value, sort_keys=True, separators=(",", ":"))


class GraphSnapshotService:
    """Creates serialized graph snapshots and computes diffs."""

    def __init__(self, graph: GraphStore, snapshot_dir: str = "./data/snapshots") -> None:
        self._graph = graph
        self._snapshot_dir = Path(snapshot_dir)

    async def create_snapshot(self, name: str | None = None, metadata: dict[str, Any] | None = None) -> dict[str, Any]:
        now = datetime.now(timezone.utc)
        snapshot_name = name or now.strftime("%Y%m%dT%H%M%SZ")
        self._snapshot_dir.mkdir(parents=True, exist_ok=True)
        path = self._snapshot_dir / f"{snapshot_name}.json"

        labels = await self._graph.get_labels()
        rel_types = await self._graph.get_relationship_types()

        nodes: list[dict[str, Any]] = []
        for label in labels:
            rows = await self._graph.query(f'SELECT qualified_name, props FROM "{label}"')
            for row in rows:
                nodes.append(
                    {
                        "label": label,
                        "qualified_name": row.get("qualified_name"),
                        "props": _parse_props(row.get("props")),
                    }
                )

        edges: list[dict[str, Any]] = []
        for rel in rel_types:
            rows = await self._graph.query(
                f'SELECT src_qualified_name, dst_qualified_name, props FROM "{rel}"'
            )
            for row in rows:
                edges.append(
                    {
                        "rel_type": rel,
                        "src_qualified_name": row.get("src_qualified_name"),
                        "dst_qualified_name": row.get("dst_qualified_name"),
                        "props": _parse_props(row.get("props")),
                    }
                )

        nodes.sort(key=lambda n: (n["label"], str(n["qualified_name"])))
        edges.sort(key=lambda e: (e["rel_type"], str(e["src_qualified_name"]), str(e["dst_qualified_name"])))

        payload = {
            "schema_version": 1,
            "created_at": now.isoformat(),
            "metadata": metadata or {},
            "labels": labels,
            "relationship_types": rel_types,
            "nodes": nodes,
            "edges": edges,
        }
        path.write_text(json.dumps(payload, indent=2), encoding="utf-8")

        return {
            "snapshot_name": snapshot_name,
            "snapshot_path": str(path),
            "created_at": payload["created_at"],
            "node_count": len(nodes),
            "edge_count": len(edges),
        }

    @staticmethod
    def load_snapshot(snapshot_path: str) -> dict[str, Any]:
        payload = json.loads(Path(snapshot_path).read_text(encoding="utf-8"))
        if not isinstance(payload, dict):
            raise ValueError("Invalid snapshot payload")
        return payload

    @classmethod
    def diff_snapshots(
        cls,
        snapshot_a_path: str,
        snapshot_b_path: str,
        max_examples: int = 200,
    ) -> dict[str, Any]:
        left = cls.load_snapshot(snapshot_a_path)
        right = cls.load_snapshot(snapshot_b_path)

        left_nodes = {
            (node.get("label"), node.get("qualified_name")): _stable_json(node.get("props", {}))
            for node in left.get("nodes", [])
        }
        right_nodes = {
            (node.get("label"), node.get("qualified_name")): _stable_json(node.get("props", {}))
            for node in right.get("nodes", [])
        }

        left_edges = {
            (edge.get("rel_type"), edge.get("src_qualified_name"), edge.get("dst_qualified_name")): _stable_json(
                edge.get("props", {})
            )
            for edge in left.get("edges", [])
        }
        right_edges = {
            (edge.get("rel_type"), edge.get("src_qualified_name"), edge.get("dst_qualified_name")): _stable_json(
                edge.get("props", {})
            )
            for edge in right.get("edges", [])
        }

        left_node_keys = set(left_nodes)
        right_node_keys = set(right_nodes)
        left_edge_keys = set(left_edges)
        right_edge_keys = set(right_edges)

        added_nodes = sorted(right_node_keys - left_node_keys)
        removed_nodes = sorted(left_node_keys - right_node_keys)
        common_nodes = left_node_keys & right_node_keys
        changed_nodes = sorted([key for key in common_nodes if left_nodes[key] != right_nodes[key]])

        added_edges = sorted(right_edge_keys - left_edge_keys)
        removed_edges = sorted(left_edge_keys - right_edge_keys)
        common_edges = left_edge_keys & right_edge_keys
        changed_edges = sorted([key for key in common_edges if left_edges[key] != right_edges[key]])

        return {
            "left_snapshot": snapshot_a_path,
            "right_snapshot": snapshot_b_path,
            "left_created_at": left.get("created_at"),
            "right_created_at": right.get("created_at"),
            "counts": {
                "added_nodes": len(added_nodes),
                "removed_nodes": len(removed_nodes),
                "changed_nodes": len(changed_nodes),
                "added_edges": len(added_edges),
                "removed_edges": len(removed_edges),
                "changed_edges": len(changed_edges),
            },
            "examples": {
                "added_nodes": [{"label": k[0], "qualified_name": k[1]} for k in added_nodes[:max_examples]],
                "removed_nodes": [{"label": k[0], "qualified_name": k[1]} for k in removed_nodes[:max_examples]],
                "changed_nodes": [{"label": k[0], "qualified_name": k[1]} for k in changed_nodes[:max_examples]],
                "added_edges": [
                    {"rel_type": k[0], "src_qualified_name": k[1], "dst_qualified_name": k[2]}
                    for k in added_edges[:max_examples]
                ],
                "removed_edges": [
                    {"rel_type": k[0], "src_qualified_name": k[1], "dst_qualified_name": k[2]}
                    for k in removed_edges[:max_examples]
                ],
                "changed_edges": [
                    {"rel_type": k[0], "src_qualified_name": k[1], "dst_qualified_name": k[2]}
                    for k in changed_edges[:max_examples]
                ],
            },
        }
