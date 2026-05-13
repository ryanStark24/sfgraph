"""Aura bundle parser.

Parses primary Aura markup files and extracts a bundle node, controller links,
and local child-component references.
"""
from __future__ import annotations

import re
from pathlib import Path

from sfgraph.ingestion.models import EdgeFact, NodeFact

_CONTROLLER_ATTR_RE = re.compile(r'\bcontroller\s*=\s*"(?P<controller>[^"]+)"')
_LOCAL_COMPONENT_RE = re.compile(r"<c:(?P<name>[A-Za-z0-9_]+)\b")


def _bundle_name_from_path(file_path: str) -> str:
    return Path(file_path).parent.name


def _base_aura_node(bundle_name: str, source_file: str, parser_type: str) -> NodeFact:
    return NodeFact(
        label="AuraComponent",
        key_props={"qualifiedName": bundle_name},
        all_props={
            "qualifiedName": bundle_name,
            "apiName": bundle_name,
            "bundleName": bundle_name,
        },
        sourceFile=source_file,
        lineNumber=0,
        parserType=parser_type,
    )


def parse_aura_file(file_path: str) -> tuple[list[NodeFact], list[EdgeFact]]:
    """Parse a primary Aura markup file (.cmp/.app/.evt/.intf)."""
    path = Path(file_path)
    content = path.read_text(encoding="utf-8", errors="replace")
    bundle_name = _bundle_name_from_path(file_path)
    parser_type = f"aura_{path.suffix.lstrip('.') or 'markup'}"

    nodes: list[NodeFact] = [_base_aura_node(bundle_name, file_path, parser_type)]
    edges: list[EdgeFact] = []

    controller_match = _CONTROLLER_ATTR_RE.search(content)
    if controller_match:
        controller_name = controller_match.group("controller").strip()
        if controller_name:
            edges.append(
                EdgeFact(
                    src_qualified_name=bundle_name,
                    src_label="AuraComponent",
                    rel_type="IMPORTS_APEX",
                    dst_qualified_name=controller_name,
                    dst_label="ApexClass",
                    confidence=0.95,
                    resolutionMethod="regex",
                    edgeCategory="CONTROL_FLOW",
                    contextSnippet=f'controller="{controller_name}"',
                )
            )

    seen_children: set[str] = set()
    for match in _LOCAL_COMPONENT_RE.finditer(content):
        child_name = match.group("name")
        if not child_name or child_name == bundle_name or child_name in seen_children:
            continue
        seen_children.add(child_name)
        edges.append(
            EdgeFact(
                src_qualified_name=bundle_name,
                src_label="AuraComponent",
                rel_type="CONTAINS_CHILD",
                dst_qualified_name=child_name,
                dst_label="AuraComponent",
                confidence=0.9,
                resolutionMethod="regex",
                edgeCategory="STRUCTURAL",
                contextSnippet=f"<c:{child_name}>",
            )
        )

    return nodes, edges
