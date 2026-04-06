"""Rules and plugin registry for org-specific query semantics."""
from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import yaml


class RulesRegistry:
    """Loads optional org-level rules from YAML/JSON configuration."""

    DEFAULT_PATH = Path(__file__).resolve().parents[3] / "config" / "graph_rules.yaml"

    def __init__(self, config_path: str | None = None) -> None:
        path = Path(config_path) if config_path else self.DEFAULT_PATH
        self._path = path
        self._raw: dict[str, Any] = {}
        if not path.exists():
            return

        text = path.read_text(encoding="utf-8")
        if path.suffix.lower() == ".json":
            payload = json.loads(text)
        else:
            payload = yaml.safe_load(text) or {}
        self._raw = payload if isinstance(payload, dict) else {}

        semantic_rules = self._raw.get("semantic_overrides", [])
        self._semantic_rules: list[dict[str, str]] = []
        if isinstance(semantic_rules, list):
            for rule in semantic_rules:
                if not isinstance(rule, dict):
                    continue
                rel_type = str(rule.get("rel_type", "")).strip()
                semantic = str(rule.get("semantic", "")).strip()
                if not rel_type or not semantic:
                    continue
                self._semantic_rules.append(
                    {
                        "rel_type": rel_type,
                        "semantic": semantic,
                        "context_contains": str(rule.get("context_contains", "")).lower().strip(),
                    }
                )

        aliases = self._raw.get("aliases", {})
        self._aliases: dict[str, str] = {}
        if isinstance(aliases, dict):
            for key, value in aliases.items():
                key_str = str(key).strip().lower()
                value_str = str(value).strip()
                if key_str and value_str:
                    self._aliases[key_str] = value_str

    def semantic_override(self, rel_type: str, context: str) -> str | None:
        lower_ctx = context.lower()
        for rule in self._semantic_rules:
            if rule["rel_type"] != rel_type:
                continue
            needle = rule["context_contains"]
            if needle and needle not in lower_ctx:
                continue
            return rule["semantic"]
        return None

    def resolve_alias(self, token: str) -> str:
        return self._aliases.get(token.lower(), token)

    def describe(self) -> dict[str, Any]:
        return {
            "path": str(self._path),
            "loaded": bool(self._raw),
            "alias_count": len(self._aliases),
            "semantic_override_count": len(self._semantic_rules),
        }
