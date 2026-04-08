"""Vlocity/OmniStudio DataPack parser.

Parses IntegrationProcedure, DataRaptor, and OmniScript JSON DataPacks into
NodeFact and EdgeFact structures consumed by IngestionService.
"""
from __future__ import annotations

from dataclasses import dataclass
import json
import re
from pathlib import Path
from typing import Any

from sfgraph.ingestion.models import EdgeFact, NodeFact
from sfgraph.parser.vlocity_registry import (
    SUPPORTED_VLOCITY_DATAPACK_TYPE_HINTS,
    SUPPORTED_VLOCITY_DATAPACK_TYPE_SET,
)

_MERGE_FIELD_RE = re.compile(r"%([A-Za-z0-9_]+):([A-Za-z0-9_]+)%")
_VLOCITY_NAME_HINTS = SUPPORTED_VLOCITY_DATAPACK_TYPE_HINTS + (
    "datapack",
    "datapacks",
    "vlocity",
    "omnistudio",
)

_SPECIALIZED_UI_PACK_TYPES: frozenset[str] = frozenset(
    {
        "UIFacet",
        "UISection",
        "VlocityCard",
        "VlocityUILayout",
        "VlocityUITemplate",
    }
)
_SUPPORTED_NON_OBJECT_VLOCITY_ARRAY_SUFFIXES: frozenset[str] = frozenset(
    {
        "PromotionItems",
        "PriceListEntries",
        "InterfaceImplementationDetails",
        "ProductChildItems",
    }
)


@dataclass(frozen=True)
class VlocityParseMetadata:
    outcome: str
    pack_type: str = ""
    parser_strategy: str = "none"
    node_label: str = ""
    unsupported_type: bool = False


def is_vlocity_datapack_file(file_path: str | Path) -> bool:
    path = Path(file_path)
    lower_name = path.name.lower()
    lower_parts = [part.lower() for part in path.parts]
    if lower_name.endswith("_datapack.json"):
        return True
    if any(hint in lower_name for hint in _VLOCITY_NAME_HINTS):
        return True
    return any(hint in part for part in lower_parts for hint in _VLOCITY_NAME_HINTS)


def _first_string(*values: Any) -> str:
    for value in values:
        if isinstance(value, str) and value.strip():
            return value.strip()
    return ""


def _safe_pack_type_for_qname(pack_type: str) -> str:
    cleaned = re.sub(r"[^A-Za-z0-9_]+", "_", pack_type.strip())
    return cleaned or "Unknown"


def _iter_keyed_strings(value: Any, key_path: tuple[str, ...] = ()) -> list[tuple[tuple[str, ...], str]]:
    hits: list[tuple[tuple[str, ...], str]] = []
    if isinstance(value, dict):
        for key, item in value.items():
            if isinstance(key, str):
                hits.extend(_iter_keyed_strings(item, key_path + (key,)))
    elif isinstance(value, list):
        for item in value:
            hits.extend(_iter_keyed_strings(item, key_path))
    elif isinstance(value, str) and value.strip():
        hits.append((key_path, value.strip()))
    return hits


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
    for supported in SUPPORTED_VLOCITY_DATAPACK_TYPE_SET:
        if supported.lower() in lower_name:
            return supported
    return ""


def _supported_non_object_pack_type(file_path: str) -> str:
    stem = Path(file_path).stem
    if "_" not in stem:
        return ""
    suffix = stem.rsplit("_", 1)[-1]
    if suffix in _SUPPORTED_NON_OBJECT_VLOCITY_ARRAY_SUFFIXES:
        return suffix
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


def _collect_reference_edges(
    src_qname: str,
    src_label: str,
    data: dict[str, Any],
    namespace: str,
    default_context: str,
) -> list[EdgeFact]:
    edges: list[EdgeFact] = []
    seen_edges: set[tuple[str, str, str]] = set()
    for key_path, raw_value in _iter_keyed_strings(data):
        normalized = _normalize_namespace(raw_value, namespace)
        lower_path = [part.lower() for part in key_path]
        if not lower_path:
            continue
        dest_label = ""
        if any("integrationprocedure" in part for part in lower_path):
            dest_label = "IntegrationProcedure"
        elif any("dataraptor" in part for part in lower_path):
            dest_label = "DataRaptor"
        elif any("omniscript" in part for part in lower_path):
            dest_label = "OmniScript"
        elif any("apex" in part or part == "classname" or part == "class" for part in lower_path):
            dest_label = "ApexClass"
        if not dest_label:
            continue
        edge_key = ("CALLS", dest_label, normalized)
        if edge_key in seen_edges:
            continue
        seen_edges.add(edge_key)
        edges.append(
            _edge(
                src_qname,
                src_label,
                "CALLS",
                normalized,
                dest_label,
                0.65,
                "heuristic",
                "CONFIG",
                ".".join(key_path[-3:]) or default_context,
            )
        )
    return edges


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
    known_steps: set[str] = set()
    if isinstance(steps, list):
        for step in steps:
            if not isinstance(step, dict):
                continue
            step_name = step.get("Name") or step.get("name")
            if not step_name:
                continue
            known_steps.add(step_name)
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
            edges.append(
                _edge(
                    name,
                    "IntegrationProcedure",
                    "HAS_STEP",
                    step_qname,
                    "IPElement",
                    1.0,
                    "direct",
                    "STRUCTURAL",
                    f"step {step_name}",
                )
            )
            edges.extend(_collect_reference_edges(step_qname, "IPElement", step, namespace, "step"))

    text_blob = json.dumps(data)
    variable_nodes: set[str] = set()
    seen_merge_edges: set[tuple[str, str, str]] = set()
    for step_name, field_name in _MERGE_FIELD_RE.findall(text_blob):
        snippet = f"%{step_name}:{field_name}%"
        if step_name in known_steps:
            step_qname = f"{name}.{step_name}"
            edge_key = ("REFERENCES_STEP_OUTPUT", step_qname, snippet)
            if edge_key in seen_merge_edges:
                continue
            seen_merge_edges.add(edge_key)
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
                    snippet,
                )
            )
        else:
            variable_qname = f"{name}.var.{step_name}"
            if variable_qname not in variable_nodes:
                variable_nodes.add(variable_qname)
                nodes.append(
                    _node(
                        "IPVariable",
                        variable_qname,
                        {
                            "name": step_name,
                            "integrationProcedure": name,
                        },
                        source_file,
                    )
                )
            edge_key = ("READS_VALUE", variable_qname, snippet)
            if edge_key in seen_merge_edges:
                continue
            seen_merge_edges.add(edge_key)
            edges.append(
                _edge(
                    name,
                    "IntegrationProcedure",
                    "READS_VALUE",
                    variable_qname,
                    "IPVariable",
                    0.75,
                    "regex_merge_field",
                    "DATA_FLOW",
                    snippet,
                )
            )

    edges.extend(_collect_reference_edges(name, "IntegrationProcedure", data, namespace, "integration_procedure"))
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


def _parse_generic_datapack(
    data: dict[str, Any],
    source_file: str,
    namespace: str,
    pack_type: str,
) -> tuple[list[NodeFact], list[EdgeFact]]:
    nodes: list[NodeFact] = []
    edges: list[EdgeFact] = []

    name = _first_string(
        data.get("Name"),
        data.get("DeveloperName"),
        data.get("MasterLabel"),
        data.get("GlobalKey"),
        data.get("Id"),
        Path(source_file).stem,
    )
    safe_pack_type = _safe_pack_type_for_qname(pack_type)
    qualified_name = f"{safe_pack_type}.{name}"

    nodes.append(
        _node(
            "VlocityDataPack",
            qualified_name,
            {
                "name": name,
                "dataPackType": pack_type,
                "subType": _first_string(data.get("SubType"), data.get("subType")),
                "sobjectType": _first_string(
                    data.get("VlocityRecordSObjectType"),
                    data.get("SObjectType"),
                    data.get("sObjectType"),
                    data.get("ObjectType"),
                    data.get("objectType"),
                ),
                "globalKey": _first_string(data.get("GlobalKey")),
                "namespace": namespace,
            },
            source_file,
        )
    )

    edges.extend(_collect_reference_edges(qualified_name, "VlocityDataPack", data, namespace, pack_type))
    return nodes, edges


def _parse_component_datapack(
    data: dict[str, Any],
    source_file: str,
    namespace: str,
    pack_type: str,
    label: str,
) -> tuple[list[NodeFact], list[EdgeFact]]:
    name = _first_string(
        data.get("Name"),
        data.get("DeveloperName"),
        data.get("MasterLabel"),
        data.get("GlobalKey"),
        Path(source_file).stem,
    )
    qualified_name = f"{_safe_pack_type_for_qname(pack_type)}.{name}"
    nodes = [
        _node(
            label,
            qualified_name,
            {
                "name": name,
                "dataPackType": pack_type,
                "subType": _first_string(data.get("SubType"), data.get("subType")),
                "componentFamily": "ui",
                "templateName": _first_string(
                    data.get("TemplateName"),
                    data.get("templateName"),
                    data.get("Template"),
                ),
                "isActive": bool(data.get("IsActive", data.get("isActive", True))),
            },
            source_file,
        )
    ]
    edges = _collect_reference_edges(qualified_name, label, data, namespace, pack_type)
    return nodes, edges


def _parse_non_object_vlocity_array(
    data: list[Any],
    source_file: str,
    namespace: str,
    pack_type: str,
) -> tuple[list[NodeFact], list[EdgeFact]]:
    stem = Path(source_file).stem
    parent_name = stem.rsplit("_", 1)[0] if "_" in stem else stem
    container_qname = f"{_safe_pack_type_for_qname(pack_type)}.{parent_name}"
    nodes: list[NodeFact] = [
        _node(
            "VlocityDataPack",
            container_qname,
            {
                "name": parent_name,
                "dataPackType": pack_type,
                "sourceShape": "non_object_json_array",
            },
            source_file,
        )
    ]
    edges: list[EdgeFact] = []

    for idx, item in enumerate(data, start=1):
        if not isinstance(item, dict):
            continue
        item_name = _first_string(
            item.get("Name"),
            item.get("DeveloperName"),
            item.get("Id"),
            f"item_{idx}",
        )
        child_qname = f"{container_qname}.{item_name}"
        nodes.append(
            _node(
                "VlocityDataPack",
                child_qname,
                {
                    "name": item_name,
                    "dataPackType": f"{pack_type}Item",
                    "parentDataPack": container_qname,
                },
                source_file,
            )
        )
        edges.append(
            _edge(
                container_qname,
                "VlocityDataPack",
                "CONTAINS_CHILD",
                child_qname,
                "VlocityDataPack",
                0.85,
                "array_item",
                "STRUCTURAL",
                f"{pack_type} item {idx}",
            )
        )
        edges.extend(_collect_reference_edges(child_qname, "VlocityDataPack", item, namespace, pack_type))

    edges.extend(_collect_reference_edges(container_qname, "VlocityDataPack", {"items": data}, namespace, pack_type))
    return nodes, edges


def parse_vlocity_json_detailed(
    file_path: str,
    namespace: str = "vlocity_cmt",
) -> tuple[list[NodeFact], list[EdgeFact], VlocityParseMetadata]:
    """Parse one Vlocity JSON candidate file and report the parse outcome."""
    path = Path(file_path)
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return [], [], VlocityParseMetadata(outcome="invalid_json")

    if not isinstance(data, dict):
        if isinstance(data, list):
            non_object_pack_type = _supported_non_object_pack_type(file_path)
            if non_object_pack_type:
                nodes, edges = _parse_non_object_vlocity_array(data, file_path, namespace, non_object_pack_type)
                return nodes, edges, VlocityParseMetadata(
                    outcome="parsed_specialized",
                    pack_type=non_object_pack_type,
                    parser_strategy="specialized",
                    node_label="VlocityDataPack",
                )
        return [], [], VlocityParseMetadata(outcome="non_object_json")

    raw_pack_type = _pack_type(data, file_path)
    if not raw_pack_type and not any(key in data for key in ("VlocityDataPackType", "DataPackType", "Type", "type")):
        return [], [], VlocityParseMetadata(outcome="non_datapack_json")

    ptype = raw_pack_type.lower()
    if ptype == "integrationprocedure":
        nodes, edges = _parse_integration_procedure(data, file_path, namespace)
        return nodes, edges, VlocityParseMetadata(
            outcome="parsed_specialized",
            pack_type=raw_pack_type,
            parser_strategy="specialized",
            node_label="IntegrationProcedure",
        )
    if ptype == "dataraptor":
        nodes, edges = _parse_data_raptor(data, file_path, namespace)
        return nodes, edges, VlocityParseMetadata(
            outcome="parsed_specialized",
            pack_type=raw_pack_type,
            parser_strategy="specialized",
            node_label="DataRaptor",
        )
    if ptype == "omniscript":
        nodes, edges = _parse_omniscript(data, file_path)
        return nodes, edges, VlocityParseMetadata(
            outcome="parsed_specialized",
            pack_type=raw_pack_type,
            parser_strategy="specialized",
            node_label="OmniScript",
        )
    if raw_pack_type in _SPECIALIZED_UI_PACK_TYPES:
        nodes, edges = _parse_component_datapack(data, file_path, namespace, raw_pack_type, raw_pack_type)
        return nodes, edges, VlocityParseMetadata(
            outcome="parsed_specialized",
            pack_type=raw_pack_type,
            parser_strategy="specialized",
            node_label=raw_pack_type,
        )

    pack_type = raw_pack_type or "Unknown"
    nodes, edges = _parse_generic_datapack(data, file_path, namespace, pack_type)
    return nodes, edges, VlocityParseMetadata(
        outcome="parsed_generic",
        pack_type=pack_type,
        parser_strategy="generic",
        node_label="VlocityDataPack",
        unsupported_type=bool(raw_pack_type and raw_pack_type not in SUPPORTED_VLOCITY_DATAPACK_TYPE_SET),
    )


def parse_vlocity_json(file_path: str, namespace: str = "vlocity_cmt") -> tuple[list[NodeFact], list[EdgeFact]]:
    """Parse one Vlocity JSON DataPack file."""
    nodes, edges, _ = parse_vlocity_json_detailed(file_path, namespace=namespace)
    return nodes, edges


class VlocityParser:
    """Directory parser for Vlocity/OmniStudio DataPack JSON files."""

    def __init__(self, namespace: str = "vlocity_cmt") -> None:
        self._namespace = namespace

    def parse_datapacks_dir(self, datapacks_dir: str) -> tuple[list[NodeFact], list[EdgeFact]]:
        all_nodes: list[NodeFact] = []
        all_edges: list[EdgeFact] = []

        for path in sorted(Path(datapacks_dir).rglob("*.json")):
            nodes, edges, _ = parse_vlocity_json_detailed(str(path), namespace=self._namespace)
            all_nodes.extend(nodes)
            all_edges.extend(edges)

        return all_nodes, all_edges
