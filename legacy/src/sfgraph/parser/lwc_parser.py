"""LWC parser for JavaScript and template HTML files.

Extracts LWC component nodes and cross-layer edges for Apex imports,
label refs, getRecord field bindings, and template composition.
"""
from __future__ import annotations

import re
from pathlib import Path

from sfgraph.ingestion.models import EdgeFact, NodeFact

_APEX_IMPORT_RE = re.compile(
    r"import\s+(?P<alias>[A-Za-z_][A-Za-z0-9_]*)\s+from\s+['\"]@salesforce/apex/(?P<class>[A-Za-z0-9_]+)\.(?P<method>[A-Za-z0-9_]+)['\"]"
)
_LABEL_IMPORT_RE = re.compile(
    r"import\s+[A-Za-z_][A-Za-z0-9_]*\s+from\s+['\"]@salesforce/label/c\.(?P<label>[A-Za-z0-9_]+)['\"]"
)
_SCHEMA_IMPORT_RE = re.compile(
    r"import\s+(?P<alias>[A-Za-z_][A-Za-z0-9_]*)\s+from\s+['\"]@salesforce/schema/(?P<object>[A-Za-z0-9_]+)\.(?P<field>[A-Za-z0-9_]+)['\"]"
)
_WIRE_BLOCK_RE = re.compile(r"@wire\s*\(\s*(?P<adapter>[A-Za-z_][A-Za-z0-9_]*)\s*,\s*\{(?P<config>.*?)\}\s*\)", re.S)
_FIELDS_ARRAY_RE = re.compile(r"fields\s*:\s*\[(?P<items>[^\]]*)\]", re.S)
_OBJ_NAME_RE = re.compile(r"objectApiName\s*:\s*['\"](?P<object>[A-Za-z0-9_]+)['\"]")
_CHILD_COMPONENT_RE = re.compile(r"<c-(?P<name>[a-z0-9\-]+)\b")
_RECORD_FORM_RE = re.compile(r"<lightning-record-form\b(?P<attrs>[^>]*)>", re.S)
_ATTR_RE = re.compile(r"(?P<name>[a-zA-Z0-9_-]+)\s*=\s*\"(?P<value>[^\"]*)\"")


def _component_name_from_path(file_path: str) -> str:
    path = Path(file_path)
    # LWC bundles are usually force-app/.../lwc/<bundle>/<bundle>.js|html
    return path.parent.name


def _base_component_node(component_name: str, source_file: str, parser_type: str) -> NodeFact:
    return NodeFact(
        label="LWCComponent",
        key_props={"qualifiedName": component_name},
        all_props={
            "qualifiedName": component_name,
            "apiName": component_name,
        },
        sourceFile=source_file,
        lineNumber=0,
        parserType=parser_type,
    )


def _is_wire_usage(js_content: str, alias: str) -> bool:
    return re.search(rf"@wire\s*\(\s*{re.escape(alias)}\b", js_content) is not None


def _is_imperative_usage(js_content: str, alias: str) -> bool:
    for match in re.finditer(rf"\b{re.escape(alias)}\s*\(", js_content):
        prefix = js_content[max(0, match.start() - 30):match.start()]
        if re.search(r"@wire\s*\(\s*$", prefix):
            continue
        return True
    return False


def _split_fields(raw: str) -> list[str]:
    out: list[str] = []
    for item in raw.split(","):
        cleaned = item.strip().strip("'\"")
        if cleaned:
            out.append(cleaned)
    return out


def parse_lwc_js(file_path: str) -> tuple[list[NodeFact], list[EdgeFact]]:
    """Parse a single LWC JavaScript file."""
    content = Path(file_path).read_text(encoding="utf-8", errors="replace")
    component = _component_name_from_path(file_path)

    nodes: list[NodeFact] = [_base_component_node(component, file_path, "lwc_js")]
    edges: list[EdgeFact] = []

    schema_aliases: dict[str, str] = {}
    for match in _SCHEMA_IMPORT_RE.finditer(content):
        schema_aliases[match.group("alias")] = f"{match.group('object')}.{match.group('field')}"

    for match in _APEX_IMPORT_RE.finditer(content):
        alias = match.group("alias")
        target_class = match.group("class")
        target_method = match.group("method")
        target_qname = f"{target_class}.{target_method}"

        if _is_wire_usage(content, alias):
            edges.append(
                EdgeFact(
                    src_qualified_name=component,
                    src_label="LWCComponent",
                    rel_type="IMPORTS_APEX",
                    dst_qualified_name=target_qname,
                    dst_label="ApexMethod",
                    confidence=0.95,
                    resolutionMethod="regex_wire",
                    edgeCategory="CONTROL_FLOW",
                    contextSnippet=f"callType=wire import {alias} from {target_qname}",
                )
            )

        if _is_imperative_usage(content, alias):
            edges.append(
                EdgeFact(
                    src_qualified_name=component,
                    src_label="LWCComponent",
                    rel_type="IMPORTS_APEX",
                    dst_qualified_name=target_qname,
                    dst_label="ApexMethod",
                    confidence=0.9,
                    resolutionMethod="regex_imperative",
                    edgeCategory="CONTROL_FLOW",
                    contextSnippet=f"callType=imperative import {alias} from {target_qname}",
                )
            )

    for match in _LABEL_IMPORT_RE.finditer(content):
        label_name = match.group("label")
        edges.append(
            EdgeFact(
                src_qualified_name=component,
                src_label="LWCComponent",
                rel_type="LWC_RESOLVES_LABEL",
                dst_qualified_name=f"CustomLabel.{label_name}",
                dst_label="CustomLabel",
                confidence=1.0,
                resolutionMethod="regex",
                edgeCategory="CONFIG",
                contextSnippet=f"@salesforce/label/c.{label_name}",
            )
        )

    for wire_match in _WIRE_BLOCK_RE.finditer(content):
        adapter = wire_match.group("adapter")
        config = wire_match.group("config")
        if adapter != "getRecord":
            continue

        object_name = None
        obj_match = _OBJ_NAME_RE.search(config)
        if obj_match:
            object_name = obj_match.group("object")

        fields_match = _FIELDS_ARRAY_RE.search(config)
        if not fields_match:
            continue

        for token in _split_fields(fields_match.group("items")):
            if token in schema_aliases:
                field_qname = schema_aliases[token]
            elif "." in token:
                field_qname = token
            elif object_name:
                field_qname = f"{object_name}.{token}"
            else:
                field_qname = token

            edges.append(
                EdgeFact(
                    src_qualified_name=component,
                    src_label="LWCComponent",
                    rel_type="WIRES_ADAPTER",
                    dst_qualified_name=field_qname,
                    dst_label="SFField",
                    confidence=0.9,
                    resolutionMethod="regex_getRecord",
                    edgeCategory="DATA_FLOW",
                    contextSnippet=f"@wire(getRecord) field={field_qname}",
                )
            )

    return nodes, edges


def parse_lwc_html(file_path: str) -> tuple[list[NodeFact], list[EdgeFact]]:
    """Parse a single LWC HTML template file."""
    content = Path(file_path).read_text(encoding="utf-8", errors="replace")
    component = _component_name_from_path(file_path)

    nodes: list[NodeFact] = [_base_component_node(component, file_path, "lwc_html")]
    edges: list[EdgeFact] = []

    for match in _CHILD_COMPONENT_RE.finditer(content):
        child = match.group("name")
        edges.append(
            EdgeFact(
                src_qualified_name=component,
                src_label="LWCComponent",
                rel_type="CONTAINS_CHILD",
                dst_qualified_name=child,
                dst_label="LWCComponent",
                confidence=1.0,
                resolutionMethod="regex",
                edgeCategory="STRUCTURAL",
                contextSnippet=f"<c-{child}>",
            )
        )

    for tag_match in _RECORD_FORM_RE.finditer(content):
        attrs = {m.group("name"): m.group("value") for m in _ATTR_RE.finditer(tag_match.group("attrs"))}
        object_name = attrs.get("object-api-name")
        fields_raw = attrs.get("fields", "")
        if not fields_raw:
            continue

        for field in _split_fields(fields_raw):
            field_qname = f"{object_name}.{field}" if object_name and "." not in field else field
            edges.append(
                EdgeFact(
                    src_qualified_name=component,
                    src_label="LWCComponent",
                    rel_type="WIRES_ADAPTER",
                    dst_qualified_name=field_qname,
                    dst_label="SFField",
                    confidence=0.85,
                    resolutionMethod="regex_record_form",
                    edgeCategory="DATA_FLOW",
                    contextSnippet=f"lightning-record-form field={field_qname}",
                )
            )

    return nodes, edges


def parse_lwc_file(file_path: str) -> tuple[list[NodeFact], list[EdgeFact]]:
    """Parse a single LWC source file based on extension."""
    if file_path.endswith(".js"):
        return parse_lwc_js(file_path)
    if file_path.endswith(".html"):
        return parse_lwc_html(file_path)
    return [], []


class LWCParser:
    """Directory parser for LWC bundle trees."""

    def parse_lwc_dir(self, lwc_dir: str) -> tuple[list[NodeFact], list[EdgeFact]]:
        all_nodes: list[NodeFact] = []
        all_edges: list[EdgeFact] = []

        for file_path in sorted(Path(lwc_dir).rglob("*")):
            if not file_path.is_file():
                continue
            if file_path.suffix not in {".js", ".html"}:
                continue
            nodes, edges = parse_lwc_file(str(file_path))
            all_nodes.extend(nodes)
            all_edges.extend(edges)

        return all_nodes, all_edges
