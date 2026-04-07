"""ApexExtractor converts worker CST payloads into NodeFact and EdgeFact."""
from __future__ import annotations

import logging
import re
from pathlib import Path

from sfgraph.ingestion.models import EdgeFact, NodeFact

logger = logging.getLogger(__name__)
_VAR_DECL_RE = re.compile(
    r"\b([A-Z][A-Za-z0-9_]*(?:__c|__mdt|__e)?)\s+([a-zA-Z_][A-Za-z0-9_]*)\b"
)
_FIELD_ACCESS_RE = re.compile(
    r"\b([a-zA-Z_][A-Za-z0-9_]*)\.([A-Za-z][A-Za-z0-9_]*__(?:c|r|mdt|e))\b"
)


def _is_probable_sobject_name(name: str) -> bool:
    if not name:
        return False
    lowered = name.lower()
    if lowered in {"insert", "update", "delete", "upsert", "merge", "undelete"}:
        return False
    if "." in name:
        return False
    # Account / Contact / Custom__c / Event__e / Metadata__mdt
    return name[0].isupper() and name.replace("__", "").replace("_", "").isalnum()


class ApexExtractor:
    """Convert worker.js output payload into ingestion model facts."""

    @staticmethod
    def _extract_variable_types(source: str) -> dict[str, str]:
        var_types: dict[str, str] = {}
        for line in source.splitlines():
            stripped = line.strip()
            if not stripped or stripped.startswith("//"):
                continue
            for match in _VAR_DECL_RE.finditer(stripped):
                var_type = match.group(1)
                var_name = match.group(2)
                if _is_probable_sobject_name(var_type):
                    var_types[var_name] = var_type
        return var_types

    @staticmethod
    def _extract_inferred_field_edges(
        source: str,
        *,
        src_qname: str,
        src_label: str,
    ) -> list[EdgeFact]:
        var_types = ApexExtractor._extract_variable_types(source)
        inferred: list[EdgeFact] = []
        seen: set[tuple[str, str, str, str]] = set()
        for line in source.splitlines():
            stripped = line.strip()
            if not stripped or stripped.startswith("//"):
                continue
            for match in _FIELD_ACCESS_RE.finditer(stripped):
                var_name = match.group(1)
                field_name = match.group(2)
                obj_type = var_types.get(var_name)
                if not obj_type:
                    continue
                dst_qname = f"{obj_type}.{field_name}"
                is_write = bool(re.search(rf"\b{re.escape(var_name)}\.{re.escape(field_name)}\s*=", stripped))
                rel_type = "WRITES_FIELD" if is_write else "READS_FIELD"
                edge_key = (rel_type, src_qname, dst_qname, stripped[:120])
                if edge_key in seen:
                    continue
                seen.add(edge_key)
                inferred.append(
                    EdgeFact(
                        src_qualified_name=src_qname,
                        src_label=src_label,
                        rel_type=rel_type,
                        dst_qualified_name=dst_qname,
                        dst_label="SFField",
                        confidence=0.7,
                        resolutionMethod="regex_inferred",
                        edgeCategory="DATA_FLOW",
                        contextSnippet=stripped[:120],
                    )
                )
        return inferred

    def extract(self, payload: dict, file_path: str) -> tuple[list[NodeFact], list[EdgeFact]]:
        if not payload or payload.get("hasError"):
            logger.warning("Skipping %s: invalid or parse-error payload", file_path)
            return [], []

        nodes: list[NodeFact] = []
        edges: list[EdgeFact] = []

        class_nodes = [n for n in payload.get("nodes", []) if n.get("nodeType") == "ApexClass"]
        primary_class_name = class_nodes[0]["name"] if class_nodes else Path(file_path).stem

        for cls_fact in class_nodes:
            qname = cls_fact["name"]
            nodes.append(
                NodeFact(
                    label="ApexClass",
                    key_props={"qualifiedName": qname},
                    all_props={
                        "qualifiedName": qname,
                        "name": cls_fact["name"],
                        "superclass": cls_fact.get("superclass"),
                        "interfaces": cls_fact.get("interfaces", []),
                        "annotations": cls_fact.get("annotations", []),
                        "isTest": cls_fact.get("isTest", False),
                    },
                    sourceFile=file_path,
                    lineNumber=cls_fact.get("startLine", 0),
                    parserType="apex_cst",
                )
            )

            if cls_fact.get("superclass"):
                edges.append(
                    EdgeFact(
                        src_qualified_name=qname,
                        src_label="ApexClass",
                        rel_type="EXTENDS",
                        dst_qualified_name=cls_fact["superclass"],
                        dst_label="ApexClass",
                        confidence=0.95,
                        resolutionMethod="cst",
                        edgeCategory="STRUCTURAL",
                        contextSnippet=f"class {qname} extends {cls_fact['superclass']}",
                    )
                )

            for iface in cls_fact.get("interfaces", []):
                edges.append(
                    EdgeFact(
                        src_qualified_name=qname,
                        src_label="ApexClass",
                        rel_type="IMPLEMENTS",
                        dst_qualified_name=iface,
                        dst_label="ApexClass",
                        confidence=0.95,
                        resolutionMethod="cst",
                        edgeCategory="STRUCTURAL",
                        contextSnippet=f"class {qname} implements {iface}",
                    )
                )

        method_nodes = [n for n in payload.get("nodes", []) if n.get("nodeType") == "ApexMethod"]
        for method_fact in method_nodes:
            method_name = method_fact.get("name", "")
            method_qname = f"{primary_class_name}.{method_name}"
            nodes.append(
                NodeFact(
                    label="ApexMethod",
                    key_props={"qualifiedName": method_qname},
                    all_props={
                        "qualifiedName": method_qname,
                        "name": method_name,
                        "className": primary_class_name,
                        "visibility": method_fact.get("visibility", "package"),
                        "isStatic": method_fact.get("isStatic", False),
                        "returnType": method_fact.get("returnType", "void"),
                        "parameters": method_fact.get("parameters", []),
                        "annotations": method_fact.get("annotations", []),
                    },
                    sourceFile=file_path,
                    lineNumber=method_fact.get("startLine", 0),
                    parserType="apex_cst",
                )
            )
            edges.append(
                EdgeFact(
                    src_qualified_name=primary_class_name,
                    src_label="ApexClass",
                    rel_type="HAS_METHOD",
                    dst_qualified_name=method_qname,
                    dst_label="ApexMethod",
                    confidence=1.0,
                    resolutionMethod="cst",
                    edgeCategory="STRUCTURAL",
                    contextSnippet=f"{primary_class_name}.{method_name}()",
                )
            )

        for ref in payload.get("potential_refs", []):
            ref_type = ref.get("refType")
            src_qname = primary_class_name
            src_label = "ApexClass"
            snippet = ref.get("contextSnippet", "")[:120]

            if ref_type == "SOQL":
                for obj_name in ref.get("fromObjects", []):
                    edges.append(
                        EdgeFact(
                            src_qualified_name=src_qname,
                            src_label=src_label,
                            rel_type="QUERIES_OBJECT",
                            dst_qualified_name=obj_name,
                            dst_label="SFObject",
                            confidence=0.95,
                            resolutionMethod="cst",
                            edgeCategory="DATA_FLOW",
                            contextSnippet=snippet,
                        )
                    )

            elif ref_type == "DML":
                target = ref.get("targetType") or ref.get("dmlType", "unknown")
                if _is_probable_sobject_name(target):
                    edges.append(
                        EdgeFact(
                            src_qualified_name=src_qname,
                            src_label=src_label,
                            rel_type="DML_ON",
                            dst_qualified_name=target,
                            dst_label="SFObject",
                            confidence=0.8 if ref.get("targetType") else 0.4,
                            resolutionMethod="cst",
                            edgeCategory="DATA_FLOW",
                            contextSnippet=snippet,
                        )
                    )

            elif ref_type == "CALLS_CLASS_METHOD":
                target_class = ref.get("targetClass", "")
                if target_class:
                    edges.append(
                        EdgeFact(
                            src_qualified_name=src_qname,
                            src_label=src_label,
                            rel_type="CALLS",
                            dst_qualified_name=target_class,
                            dst_label="ApexClass",
                            confidence=0.8,
                            resolutionMethod="cst",
                            edgeCategory="CONTROL_FLOW",
                            contextSnippet=snippet,
                        )
                    )

            elif ref_type == "READS_LABEL":
                label_name = ref.get("labelName", "")
                if label_name:
                    edges.append(
                        EdgeFact(
                            src_qualified_name=src_qname,
                            src_label=src_label,
                            rel_type="READS_LABEL",
                            dst_qualified_name=f"CustomLabel.{label_name}",
                            dst_label="CustomLabel",
                            confidence=1.0,
                            resolutionMethod="cst",
                            edgeCategory="CONFIG",
                            contextSnippet=f"System.Label.{label_name}",
                        )
                    )

            elif ref_type == "READS_CUSTOM_SETTING":
                setting_type = ref.get("settingType", "")
                if setting_type:
                    edges.append(
                        EdgeFact(
                            src_qualified_name=src_qname,
                            src_label=src_label,
                            rel_type="READS_CUSTOM_SETTING",
                            dst_qualified_name=f"CustomSetting.{setting_type}",
                            dst_label="CustomSetting",
                            confidence=0.9,
                            resolutionMethod="cst",
                            edgeCategory="CONFIG",
                            contextSnippet=snippet,
                        )
                    )

            elif ref_type == "READS_CUSTOM_METADATA":
                metadata_type = ref.get("metadataType", "")
                if metadata_type:
                    edges.append(
                        EdgeFact(
                            src_qualified_name=src_qname,
                            src_label=src_label,
                            rel_type="READS_CUSTOM_METADATA",
                            dst_qualified_name=f"CustomMetadataType.{metadata_type}",
                            dst_label="CustomMetadataType",
                            confidence=0.9,
                            resolutionMethod="cst",
                            edgeCategory="CONFIG",
                            contextSnippet=snippet,
                        )
                    )

            elif ref_type == "PUBLISHES_EVENT":
                event_type = ref.get("eventType", "")
                if event_type:
                    edges.append(
                        EdgeFact(
                            src_qualified_name=src_qname,
                            src_label=src_label,
                            rel_type="PUBLISHES_EVENT",
                            dst_qualified_name=event_type,
                            dst_label="PlatformEvent",
                            confidence=0.95,
                            resolutionMethod="cst",
                            edgeCategory="DATA_FLOW",
                            contextSnippet=snippet,
                        )
                    )

            elif ref_type == "CALLS_EXTERNAL":
                namespace = ref.get("namespace", "")
                if namespace:
                    edges.append(
                        EdgeFact(
                            src_qualified_name=src_qname,
                            src_label=src_label,
                            rel_type="CALLS_EXTERNAL",
                            dst_qualified_name=f"ExternalNamespace.{namespace}",
                            dst_label="ExternalNamespace",
                            confidence=0.7,
                            resolutionMethod="cst",
                            edgeCategory="CONTROL_FLOW",
                            contextSnippet=snippet,
                        )
                    )

            elif ref_type == "PICKLIST_COMPARISON":
                field_name = ref.get("fieldName", "")
                comparand = ref.get("comparand", "")
                if field_name and comparand:
                    edges.append(
                        EdgeFact(
                            src_qualified_name=src_qname,
                            src_label=src_label,
                            rel_type="READS_VALUE",
                            dst_qualified_name=f"UNRESOLVED.{field_name}.{comparand}",
                            dst_label="SFPicklistValue",
                            confidence=0.5,
                            resolutionMethod="cst",
                            edgeCategory="DATA_FLOW",
                            contextSnippet=snippet,
                        )
                    )

        # Best-effort local dataflow inference from source text.
        # This catches common "SObject var + field assignment" patterns missed by CST refs.
        try:
            source = Path(file_path).read_text(encoding="utf-8", errors="ignore")
        except Exception:
            source = ""
        if source:
            edges.extend(
                self._extract_inferred_field_edges(
                    source,
                    src_qname=primary_class_name,
                    src_label="ApexClass",
                )
            )

        return nodes, edges
