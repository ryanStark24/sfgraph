"""Vlocity/OmniStudio DataPack parser.

Parses IntegrationProcedure, DataRaptor, and OmniScript JSON DataPacks into
NodeFact and EdgeFact structures consumed by IngestionService.
"""
from __future__ import annotations

import json
import re
from pathlib import Path
from typing import Any

from sfgraph.ingestion.models import EdgeFact, NodeFact

_MERGE_FIELD_RE = re.compile(r"%([A-Za-z0-9_]+):([A-Za-z0-9_]+)%")


def _normalize_namespace(value: str, namespace: str) -> str:
    return value.replace("%vlocity_namespace%", namespace)


def _pack_type(data: dict[str, Any], file_path: str) -> str:
    candidates = [
        data.get("VlocityDataPackType"),
        data.get("DataPackType"),
        data.get("Type"),
        data.get("type"),
    ]
    for item in candidates:
        if isinstance(item, str) and item:
            return item

    lower_name = Path(file_path).name.lower()
    if "integrationprocedure" in lower_name:
        return "IntegrationProcedure"
    if "dataraptor" in lower_name:
        return "DataRaptor"
    if "omniscript" in lower_name:
        return "OmniScript"
    return ""


def _edge(
    src_q: str,
    src_label: str,
    rel: str,
    dst_q: str,
    dst_label: str,
    conf: float,
    method: str,
    category: str,
    snippet: str,
) -> EdgeFact:
    return EdgeFact(
        src_qualified_name=src_q,
        src_label=src_label,
        rel_type=rel,
        dst_qualified_name=dst_q,
        dst_label=dst_label,
        confidence=conf,
        resolutionMethod=method,
        edgeCategory=category,
        contextSnippet=snippet[:120],
    )


def _node(label: str, qname: str, props: dict[str, Any], source_file: str) -> NodeFact:
    merged_props = {"qualifiedName": qname, **props}
    return NodeFact(
        label=label,
        key_props={"qualifiedName": qname},
        all_props=merged_props,
        sourceFile=source_file,
        lineNumber=0,
        parserType="vlocity_json",
    )


def _parse_integration_procedure(
    data: dict[str, Any],
    source_file: str,
    namespace: str,
) -> tuple[list[NodeFact], list[EdgeFact]]:
    nodes: list[NodeFact] = []
    edges: list[EdgeFact] = []

    name = data.get("Name") or data.get("IntegrationProcedureName") or Path(source_file).stem
    version = str(data.get("Version") or data.get("version") or "")
    is_active = bool(data.get("IsActive", data.get("isActive", True)))

    nodes.append(
        _node(
            "IntegrationProcedure",
            name,
            {
                "name": name,
                "version": version,
                "isActive": is_active,
            },
            source_file,
        )
    )

    steps = data.get("Steps") or data.get("steps") or []
    if isinstance(steps, list):
        for step in steps:
            if not isinstance(step, dict):
                continue
            step_name = step.get("Name") or step.get("name")
            if not step_name:
                continue
            step_qname = f"{name}.{step_name}"
            nodes.append(
                _node(
                    "IPElement",
                    step_qname,
                    {
                        "name": step_name,
                        "integrationProcedure": name,
                        "stepType": step.get("Type") or step.get("type") or "",
                    },
                    source_file,
                )
            )

    text_blob = json.dumps(data)
    for step_name, field_name in _MERGE_FIELD_RE.findall(text_blob):
        step_qname = f"{name}.{step_name}"
        edges.append(
            _edge(
                name,
                "IntegrationProcedure",
                "REFERENCES_STEP_OUTPUT",
                step_qname,
                "IPElement",
                0.85,
                "regex_merge_field",
                "DATA_FLOW",
                f"%{step_name}:{field_name}%",
            )
        )

    return nodes, edges


def _extract_fields_from_mappings(mappings: list[Any]) -> tuple[list[str], list[str], list[str], list[str]]:
    src_objects: list[str] = []
    src_fields: list[str] = []
    dst_objects: list[str] = []
    dst_fields: list[str] = []

    for mapping in mappings:
        if not isinstance(mapping, dict):
            continue
        src_obj = mapping.get("SourceObject") or mapping.get("sourceObject")
        src_field = mapping.get("SourceField") or mapping.get("sourceField")
        dst_obj = mapping.get("DestinationObject") or mapping.get("destinationObject")
        dst_field = mapping.get("DestinationField") or mapping.get("destinationField")

        if src_obj:
            src_objects.append(str(src_obj))
        if src_field:
            src_fields.append(str(src_field))
        if dst_obj:
            dst_objects.append(str(dst_obj))
        if dst_field:
            dst_fields.append(str(dst_field))

    return src_objects, src_fields, dst_objects, dst_fields


def _parse_data_raptor(
    data: dict[str, Any],
    source_file: str,
    namespace: str,
) -> tuple[list[NodeFact], list[EdgeFact]]:
    nodes: list[NodeFact] = []
    edges: list[EdgeFact] = []

    name = data.get("Name") or data.get("DataRaptorName") or Path(source_file).stem
    dr_type = (data.get("DataRaptorType") or data.get("type") or data.get("Type") or "").lower()

    nodes.append(
        _node(
            "DataRaptor",
            name,
            {
                "name": name,
                "dataRaptorType": dr_type,
                "isActive": bool(data.get("IsActive", data.get("isActive", True))),
            },
            source_file,
        )
    )

    source_object = data.get("SourceObject") or data.get("sourceObject")
    destination_object = data.get("DestinationObject") or data.get("destinationObject")

    source_fields = data.get("SourceFields") or data.get("sourceFields") or []
    destination_fields = data.get("DestinationFields") or data.get("destinationFields") or []

    mappings = data.get("Mappings") or data.get("mappings") or []
    map_src_objects, map_src_fields, map_dst_objects, map_dst_fields = _extract_fields_from_mappings(mappings if isinstance(mappings, list) else [])

    # Normalize namespace placeholders across parsed values.
    if isinstance(source_object, str):
        source_object = _normalize_namespace(source_object, namespace)
    if isinstance(destination_object, str):
        destination_object = _normalize_namespace(destination_object, namespace)
    source_fields = [_normalize_namespace(str(v), namespace) for v in source_fields if isinstance(v, (str, int, float))]
    destination_fields = [_normalize_namespace(str(v), namespace) for v in destination_fields if isinstance(v, (str, int, float))]
    map_src_objects = [_normalize_namespace(str(v), namespace) for v in map_src_objects]
    map_src_fields = [_normalize_namespace(str(v), namespace) for v in map_src_fields]
    map_dst_objects = [_normalize_namespace(str(v), namespace) for v in map_dst_objects]
    map_dst_fields = [_normalize_namespace(str(v), namespace) for v in map_dst_fields]

    if dr_type == "extract":
        read_object = source_object or (map_src_objects[0] if map_src_objects else None)
        read_fields = source_fields or map_src_fields
        for field in read_fields:
            dst_qname = f"{read_object}.{field}" if read_object and "." not in field else field
            edges.append(
                _edge(name, "DataRaptor", "DR_READS", dst_qname, "SFField", 0.95, "direct", "DATA_FLOW", f"extract {dst_qname}")
            )

    elif dr_type == "load":
        write_object = destination_object or (map_dst_objects[0] if map_dst_objects else None)
        write_fields = destination_fields or map_dst_fields
        for field in write_fields:
            dst_qname = f"{write_object}.{field}" if write_object and "." not in field else field
            edges.append(
                _edge(name, "DataRaptor", "DR_WRITES", dst_qname, "SFField", 0.95, "direct", "DATA_FLOW", f"load {dst_qname}")
            )

    elif dr_type == "transform":
        input_dr = data.get("InputDataRaptor") or data.get("inputDataRaptor") or data.get("SourceDataRaptor")
        if isinstance(input_dr, str) and input_dr:
            edges.append(
                _edge(name, "DataRaptor", "DR_TRANSFORMS", input_dr, "DataRaptor", 0.85, "direct", "DATA_FLOW", f"transform input {input_dr}")
            )

        for src_obj, src_field in zip(map_src_objects, map_src_fields):
            dst_qname = f"{src_obj}.{src_field}" if src_obj and "." not in src_field else src_field
            edges.append(
                _edge(name, "DataRaptor", "DR_READS", dst_qname, "SFField", 0.8, "mapping", "DATA_FLOW", f"transform reads {dst_qname}")
            )
        for dst_obj, dst_field in zip(map_dst_objects, map_dst_fields):
            dst_qname = f"{dst_obj}.{dst_field}" if dst_obj and "." not in dst_field else dst_field
            edges.append(
                _edge(name, "DataRaptor", "DR_WRITES", dst_qname, "SFField", 0.8, "mapping", "DATA_FLOW", f"transform writes {dst_qname}")
            )

    return nodes, edges


def _parse_omniscript(
    data: dict[str, Any],
    source_file: str,
) -> tuple[list[NodeFact], list[EdgeFact]]:
    nodes: list[NodeFact] = []
    edges: list[EdgeFact] = []

    name = data.get("Name") or data.get("OmniScriptName") or Path(source_file).stem
    os_type = data.get("Type") or data.get("OmniScriptType") or ""
    subtype = data.get("SubType") or data.get("subType") or ""
    is_active = bool(data.get("IsActive", data.get("isActive", True)))

    nodes.append(
        _node(
            "OmniScript",
            name,
            {
                "name": name,
                "type": os_type,
                "subType": subtype,
                "isActive": is_active,
            },
            source_file,
        )
    )

    apex_actions = data.get("ApexActions") or data.get("apexActions") or []
    for action in apex_actions:
        if not isinstance(action, dict):
            continue
        class_name = action.get("ClassName") or action.get("className")
        if not class_name:
            continue
        edges.append(
            _edge(name, "OmniScript", "CALLS", class_name, "ApexClass", 0.8, "direct", "CONTROL_FLOW", f"omniscript apex {class_name}")
        )

    ips = data.get("IntegrationProcedures") or data.get("integrationProcedures") or []
    for ip_name in ips:
        if not isinstance(ip_name, str) or not ip_name:
            continue
        edges.append(
            _edge(name, "OmniScript", "CALLS", ip_name, "IntegrationProcedure", 0.8, "direct", "CONTROL_FLOW", f"omniscript ip {ip_name}")
        )

    return nodes, edges


def parse_vlocity_json(file_path: str, namespace: str = "vlocity_cmt") -> tuple[list[NodeFact], list[EdgeFact]]:
    """Parse one Vlocity JSON DataPack file."""
    path = Path(file_path)
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return [], []

    if not isinstance(data, dict):
        return [], []

    ptype = _pack_type(data, file_path).lower()
    if ptype == "integrationprocedure":
        return _parse_integration_procedure(data, file_path, namespace)
    if ptype == "dataraptor":
        return _parse_data_raptor(data, file_path, namespace)
    if ptype == "omniscript":
        return _parse_omniscript(data, file_path)
    return [], []


class VlocityParser:
    """Directory parser for Vlocity/OmniStudio DataPack JSON files."""

    def __init__(self, namespace: str = "vlocity_cmt") -> None:
        self._namespace = namespace

    def parse_datapacks_dir(self, datapacks_dir: str) -> tuple[list[NodeFact], list[EdgeFact]]:
        all_nodes: list[NodeFact] = []
        all_edges: list[EdgeFact] = []

        for path in sorted(Path(datapacks_dir).rglob("*.json")):
            nodes, edges = parse_vlocity_json(str(path), namespace=self._namespace)
            all_nodes.extend(nodes)
            all_edges.extend(edges)

        return all_nodes, all_edges
