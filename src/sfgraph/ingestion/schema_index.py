"""Schema index materialization for ingestion.

Creates a compact schema snapshot for downstream query tooling.
"""
from __future__ import annotations

import json
import logging
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from sfgraph.ingestion.constants import EDGE_CATEGORIES, NODE_TYPE_DESCRIPTIONS
from sfgraph.storage.base import GraphStore

logger = logging.getLogger(__name__)


async def _sample_label_properties(graph: GraphStore, label: str) -> list[str]:
    """Return a best-effort list of property keys for a given label."""
    # Cypher-style path first (for graph backends that support it).
    try:
        rows = await graph.query(f"MATCH (n:{label}) RETURN n LIMIT 1")
        if rows:
            node_data = rows[0].get("n")
            if isinstance(node_data, dict):
                return sorted(node_data.keys())
    except Exception:
        pass

    # DuckPGQ fallback (node table with JSON props column).
    try:
        rows = await graph.query(f'SELECT props FROM "{label}" LIMIT 1')
        if not rows:
            return []
        payload = rows[0].get("props")
        if isinstance(payload, str):
            payload = json.loads(payload)
        if isinstance(payload, dict):
            return sorted(payload.keys())
    except Exception as exc:
        logger.debug("Property sampling failed for label %s: %s", label, exc)
    return []


async def materialize_schema_index(graph: GraphStore, output_path: str) -> dict[str, Any]:
    """Materialize schema index JSON and return the in-memory representation."""
    labels = await graph.get_labels()
    rel_types = await graph.get_relationship_types()

    node_types: dict[str, dict[str, Any]] = {}
    for label in sorted(labels):
        node_types[label] = {
            "properties": await _sample_label_properties(graph, label),
            "description": NODE_TYPE_DESCRIPTIONS.get(label, ""),
        }

    schema = {
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "node_types": node_types,
        "relationship_types": sorted(rel_types),
        "edge_categories": sorted(EDGE_CATEGORIES),
    }

    out = Path(output_path)
    out.parent.mkdir(parents=True, exist_ok=True)
    with out.open("w", encoding="utf-8") as fh:
        json.dump(schema, fh, indent=2)

    logger.info(
        "Schema index materialized with %d labels and %d relationship types at %s",
        len(labels),
        len(rel_types),
        output_path,
    )
    return schema
