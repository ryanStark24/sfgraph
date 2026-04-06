"""Dynamic Accessor Registry for Apex parser patterns.

Loads config/dynamic_accessors.yaml and matches known (class, method)
invocations to emit edge candidates for dynamic access patterns.
"""
from __future__ import annotations

import logging
from pathlib import Path

import yaml

from sfgraph.ingestion.models import EdgeFact

logger = logging.getLogger(__name__)


def _default_config_path() -> Path:
    packaged = Path(__file__).resolve().parents[1] / "config" / "dynamic_accessors.yaml"
    if packaged.exists():
        return packaged
    return Path(__file__).resolve().parents[3] / "config" / "dynamic_accessors.yaml"


class DynamicAccessorRegistry:
    """Loads YAML accessor rules and emits matching edge candidates."""

    def __init__(self, config_path: str | None = None) -> None:
        path = Path(config_path) if config_path else _default_config_path()
        if not path.exists():
            logger.warning("Dynamic accessor config not found at %s", path)
            self._index: dict[tuple[str, str], dict] = {}
            return

        with path.open("r", encoding="utf-8") as fh:
            raw = yaml.safe_load(fh) or {}

        self._index: dict[tuple[str, str], dict] = {}
        for entry in raw.get("accessors", []):
            class_name = entry.get("class")
            method_name = entry.get("method")
            if not class_name or not method_name:
                continue
            self._index[(class_name.lower(), method_name.lower())] = entry

        logger.info("Loaded %d dynamic accessor rules from %s", len(self._index), path)

    def match(
        self,
        class_name: str,
        method_name: str,
        src_qualified_name: str,
        src_label: str,
        context_snippet: str = "",
    ) -> list[EdgeFact]:
        """Return EdgeFact candidates when a rule matches class/method."""
        entry = self._index.get((class_name.lower(), method_name.lower()))
        if not entry:
            return []

        return [
            EdgeFact(
                src_qualified_name=src_qualified_name,
                src_label=src_label,
                rel_type=entry["edge_type"],
                dst_qualified_name=f"ExternalNamespace.{class_name}",
                dst_label="ExternalNamespace",
                confidence=entry["confidence"],
                resolutionMethod=entry["resolution_method"],
                edgeCategory=entry["edge_category"],
                contextSnippet=context_snippet[:120],
            )
        ]
