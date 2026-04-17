"""Helpers for analyze response caching and presentation."""
from __future__ import annotations

import time
from copy import deepcopy
from typing import Any


class AnalyzeResponseCache:
    """Tiny TTL cache for fully assembled analyze responses."""

    def __init__(self, ttl_seconds: float = 15.0) -> None:
        self._ttl_seconds = ttl_seconds
        self._entries: dict[str, tuple[float, dict[str, Any]]] = {}

    @property
    def ttl_seconds(self) -> float:
        return self._ttl_seconds

    def get(self, cache_key: str) -> dict[str, Any] | None:
        cached = self._entries.get(cache_key)
        if cached is None:
            return None
        cached_at, payload = cached
        if (time.monotonic() - cached_at) > self._ttl_seconds:
            self._entries.pop(cache_key, None)
            return None
        cloned = deepcopy(payload)
        cloned["cache"] = {"hit": True, "ttl_seconds": self._ttl_seconds}
        return cloned

    def store(self, cache_key: str, payload: dict[str, Any]) -> None:
        if payload.get("partial_results"):
            return
        self._entries[cache_key] = (time.monotonic(), deepcopy(payload))

    def clear(self) -> None:
        self._entries.clear()


def render_analyze_markdown(payload: dict[str, Any]) -> str:
    routed_to = str(payload.get("routed_to") or "")
    section_title = "Evidence"
    if routed_to == "analyze_field":
        section_title = "Field Evidence"
    elif routed_to == "analyze_object_event":
        section_title = "Lifecycle Evidence"
    elif routed_to == "analyze_change":
        section_title = "Impact Evidence"
    elif routed_to == "analyze_component":
        section_title = "Component Evidence"

    lines = [
        "# Analyze Result",
        "",
        f"- Question: {payload.get('question', '')}",
        f"- Routed to: {payload.get('routed_to', '')}",
        f"- Mode: {payload.get('analysis_mode', '')}",
        f"- Strict: {payload.get('strict', False)}",
        "",
        f"## {section_title}",
    ]
    evidence = payload.get("evidence", [])
    if not isinstance(evidence, list) or not evidence:
        lines.append("- No evidence found.")
    else:
        for item in evidence[:10]:
            if not isinstance(item, dict):
                continue
            label = str(item.get("label") or item.get("dst_label") or item.get("src_label") or "Node")
            qname = str(
                item.get("qualifiedName")
                or item.get("scopedQualifiedName")
                or item.get("target_node")
                or item.get("dst")
                or item.get("src")
                or ""
            )
            source_file = str(item.get("sourceFile") or item.get("source_file") or "")
            source_line = item.get("lineNumber") or item.get("source_line")
            detail = f"{label}: {qname}".strip()
            if source_file:
                if source_line:
                    detail += f" ({source_file}:{source_line})"
                else:
                    detail += f" ({source_file})"
            lines.append(f"- {detail}")
    freshness = payload.get("freshness")
    if isinstance(freshness, dict) and freshness:
        lines.extend(
            [
                "",
                "## Freshness",
                f"- Indexed at: {freshness.get('indexed_at', '')}",
                f"- Dirty files pending: {freshness.get('dirty_files_pending', '')}",
                f"- Partial results: {freshness.get('partial_results', False)}",
            ]
        )
    presentation = payload.get("presentation")
    if isinstance(presentation, dict) and presentation.get("mermaid"):
        lines.extend(["", "## Diagram", "```mermaid", str(presentation["mermaid"]), "```"])
    return "\n".join(lines).strip()


def candidate_qname_from_item(item: dict[str, Any]) -> str:
    return str(
        item.get("scopedQualifiedName")
        or item.get("qualifiedName")
        or item.get("target_node")
        or item.get("dst")
        or item.get("src")
        or item.get("field")
        or item.get("component")
        or ""
    )


def candidate_qnames_for_payload(payload: dict[str, Any]) -> list[str]:
    result = payload.get("result")
    candidates: list[str] = []

    def _add(candidate: Any) -> None:
        value = str(candidate or "").strip()
        if value and value not in candidates:
            candidates.append(value)

    if isinstance(result, dict):
        _add(result.get("start_node"))
        for key in ("resolved_fields", "resolved_components"):
            values = result.get(key)
            if isinstance(values, list):
                for value in values:
                    _add(value)
        fields = result.get("fields")
        if isinstance(fields, list):
            for field in fields:
                if not isinstance(field, dict):
                    continue
                _add(field.get("field"))
                for nested_key in ("writers", "readers", "dependents"):
                    nested = field.get(nested_key)
                    if not isinstance(nested, list):
                        continue
                    for item in nested:
                        if isinstance(item, dict):
                            _add(candidate_qname_from_item(item))
        for list_key in ("graph_findings", "findings", "exact_matches"):
            items = result.get(list_key)
            if not isinstance(items, list):
                continue
            for item in items:
                if isinstance(item, dict):
                    _add(candidate_qname_from_item(item))

    evidence = payload.get("evidence", [])
    if isinstance(evidence, list):
        for item in evidence:
            if isinstance(item, dict):
                _add(candidate_qname_from_item(item))

    return candidates


def build_analyze_payload(
    *,
    question: str,
    analysis_mode: str,
    strict: bool,
    routed_to: str,
    result: dict[str, Any],
    evidence: list[dict[str, Any]],
    confidence_tiers: dict[str, Any],
    routing_stages: list[dict[str, Any]],
    semantic_fallback_reason: str | None,
    freshness: dict[str, Any],
) -> dict[str, Any]:
    return {
        "mode": "analyze",
        "question": question,
        "analysis_mode": analysis_mode,
        "strict": strict,
        "routed_to": routed_to,
        "result": result,
        "evidence": evidence,
        "confidence_tiers": confidence_tiers,
        "routing": {
            "policy": "exact_then_graph_then_semantic",
            "stages": routing_stages,
        },
        "confidence_gate": {
            "has_material_evidence": bool(evidence),
            "evidence_count": len(evidence),
        },
        "fallback": {
            "semantic_invoked": any(stage.get("stage") == "semantic_fallback" for stage in routing_stages),
            "reason": semantic_fallback_reason,
        },
        "freshness": freshness,
        "partial_results": bool(result.get("partial_results", False)),
    }
