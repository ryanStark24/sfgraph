"""Graph visualization helpers."""
from __future__ import annotations

import re
from typing import Any


def render_mermaid_subgraph(*, center: str, node_label: str, incoming: list[dict[str, Any]], outgoing: list[dict[str, Any]]) -> str:
    lines = ['%%{init: {"theme": "neutral"}}%%', "graph TD"]
    emitted_nodes: set[str] = set()

    def _node_id(value: str) -> str:
        return re.sub(r"[^A-Za-z0-9_]", "_", value) or "node"

    def _emit_node(name: str, label: str) -> None:
        node_id = _node_id(name)
        if node_id in emitted_nodes:
            return
        emitted_nodes.add(node_id)
        safe_label = label.replace('"', "'")
        lines.append(f'    {node_id}["{safe_label}"]')

    _emit_node(center, f"{center} ({node_label})")
    for edge in incoming:
        src = str(edge.get("src") or "")
        if not src:
            continue
        _emit_node(src, src)
        lines.append(f'    {_node_id(src)} -- "{edge.get("rel_type", "")}" --> {_node_id(center)}')
    for edge in outgoing:
        dst = str(edge.get("dst") or "")
        if not dst:
            continue
        _emit_node(dst, dst)
        lines.append(f'    {_node_id(center)} -- "{edge.get("rel_type", "")}" --> {_node_id(dst)}')
    return "\n".join(lines)
