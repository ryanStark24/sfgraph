"""Object metadata XML parser for Salesforce.

Parses .object-meta.xml, .field-meta.xml, .labels-meta.xml/.label-meta.xml,
.globalValueSet-meta.xml, and customMetadata/*.md-meta.xml files.
Returns NodeFact + EdgeFact lists consumed by IngestionService.

PITFALL: All elements are in NS="http://soap.sforce.com/2006/04/metadata"
PITFALL: Always use _tag() for all find/findtext calls — bare names return None
PITFALL: Field files can be in <object_dir>/fields/<field>.field-meta.xml
         OR as <fields> children inside the object-meta.xml itself
"""
from __future__ import annotations

import re
from pathlib import Path
from typing import Any
import xml.etree.ElementTree as ET

from sfgraph.ingestion.models import NodeFact, EdgeFact

NS = "http://soap.sforce.com/2006/04/metadata"


def _tag(name: str) -> str:
    return f"{{{NS}}}{name}"


# Regex to find field references in formula text (e.g. Date_Listed__c, Name)
_FORMULA_FIELD_RE = re.compile(r'\b([A-Z][A-Za-z0-9_]*(?:__c|__r)?)\b')


def _detect_object_node_type(obj_xml_path: Path) -> str:
    """Determine the NodeFact label from the object XML filename."""
    stem = obj_xml_path.parent.name  # directory name is the object API name
    if stem.endswith("__e"):
        return "PlatformEvent"
    if stem.endswith("__mdt"):
        return "CustomMetadataType"
    # Check for customSettingsType element in the file
    try:
        tree = ET.parse(str(obj_xml_path))
        root = tree.getroot()
        if root.find(_tag("customSettingsType")) is not None:
            return "CustomSetting"
    except ET.ParseError:
        pass
    return "SFObject"


def parse_field_xml(
    field_path: str,
    object_api_name: str,
) -> tuple[list[NodeFact], list[EdgeFact]]:
    """Parse a single .field-meta.xml file."""
    nodes: list[NodeFact] = []
    edges: list[EdgeFact] = []

    tree = ET.parse(field_path)
    root = tree.getroot()

    full_name = root.findtext(_tag("fullName")) or Path(field_path).stem.replace(".field-meta", "")
    label = root.findtext(_tag("label")) or full_name
    field_type = root.findtext(_tag("type")) or ""
    required = root.findtext(_tag("required")) == "true"
    formula_text = root.findtext(_tag("formula"))
    is_formula = formula_text is not None

    field_qname = f"{object_api_name}.{full_name}"

    field_node = NodeFact(
        label="SFField",
        key_props={"qualifiedName": field_qname},
        all_props={
            "qualifiedName": field_qname,
            "apiName": full_name,
            "objectApiName": object_api_name,
            "apiLabel": label,
            "fieldType": field_type,
            "required": required,
            "isFormula": is_formula,
        },
        sourceFile=field_path, lineNumber=0, parserType="xml_object",
    )
    nodes.append(field_node)
    # Emit CustomMetadataField nodes for __mdt objects so the declared graph
    # labels are actually populated during ingestion.
    if object_api_name.endswith("__mdt"):
        nodes.append(
            NodeFact(
                label="CustomMetadataField",
                key_props={"qualifiedName": field_qname},
                all_props={
                    "qualifiedName": field_qname,
                    "apiName": full_name,
                    "objectApiName": object_api_name,
                    "apiLabel": label,
                    "fieldType": field_type,
                    "required": required,
                    "isFormula": is_formula,
                },
                sourceFile=field_path,
                lineNumber=0,
                parserType="xml_object",
            )
        )

    # OBJ-06: Formula field dependencies
    if is_formula and formula_text:
        refs = set(_FORMULA_FIELD_RE.findall(formula_text))
        # Filter out obvious non-field tokens (functions, keywords)
        skip = {"TODAY", "NOW", "DATE", "DATEVALUE", "IF", "AND", "OR", "NOT", "TRUE", "FALSE", "NULL"}
        for ref in refs:
            if ref in skip:
                continue
            dst_qname = f"{object_api_name}.{ref}"
            edges.append(EdgeFact(
                src_qualified_name=field_qname, src_label="SFField",
                rel_type="FORMULA_DEPENDS_ON",
                dst_qualified_name=dst_qname, dst_label="SFField",
                confidence=0.85, resolutionMethod="regex",
                edgeCategory="DATA_FLOW",
                contextSnippet=f"formula: {formula_text[:80]}",
            ))

    # OBJ-02/03: Picklist values (inline valueSetDefinition)
    is_picklist = field_type in ("Picklist", "MultiselectPicklist")
    value_set = root.find(_tag("valueSet"))
    if value_set is not None:
        value_set_name = value_set.findtext(_tag("valueSetName"))
        if value_set_name:
            # OBJ-04: Global value set reference
            edges.append(EdgeFact(
                src_qualified_name=field_qname, src_label="SFField",
                rel_type="FIELD_USES_GLOBAL_SET",
                dst_qualified_name=value_set_name, dst_label="GlobalValueSet",
                confidence=1.0, resolutionMethod="direct",
                edgeCategory="STRUCTURAL",
                contextSnippet=f"valueSetName: {value_set_name}",
            ))
        else:
            vsd = value_set.find(_tag("valueSetDefinition"))
            if vsd is not None:
                for val in vsd.findall(_tag("value")):
                    val_name = val.findtext(_tag("fullName")) or ""
                    val_label = val.findtext(_tag("label")) or val_name
                    is_default = val.findtext(_tag("default")) == "true"
                    if val_name:
                        val_qname = f"{field_qname}.{val_name}"
                        nodes.append(NodeFact(
                            label="SFPicklistValue",
                            key_props={"qualifiedName": val_qname},
                            all_props={
                                "qualifiedName": val_qname,
                                "apiName": val_name,
                                "apiLabel": val_label,
                                "isDefault": is_default,
                                "fieldQualifiedName": field_qname,
                            },
                            sourceFile=field_path, lineNumber=0, parserType="xml_object",
                        ))
                        edges.append(EdgeFact(
                            src_qualified_name=field_qname, src_label="SFField",
                            rel_type="FIELD_HAS_VALUE",
                            dst_qualified_name=val_qname, dst_label="SFPicklistValue",
                            confidence=1.0, resolutionMethod="direct",
                            edgeCategory="STRUCTURAL",
                            contextSnippet=f"picklist value: {val_name}",
                        ))

    return nodes, edges


def parse_object_dir(object_dir: str) -> tuple[list[NodeFact], list[EdgeFact]]:
    """Parse an object metadata directory (e.g. objects/Account/).

    Expects:
      <object_dir>/
        <ObjectName>.object-meta.xml     (object definition)
        fields/
          <FieldName>.field-meta.xml     (individual field files)
    """
    nodes: list[NodeFact] = []
    edges: list[EdgeFact] = []

    obj_dir_path = Path(object_dir)
    object_api_name = obj_dir_path.name

    # Find .object-meta.xml
    obj_xml_files = list(obj_dir_path.glob("*.object-meta.xml"))
    if obj_xml_files:
        obj_xml_path = obj_xml_files[0]
        node_type = _detect_object_node_type(obj_xml_path)

        tree = ET.parse(str(obj_xml_path))
        root = tree.getroot()
        api_label = root.findtext(_tag("label")) or object_api_name
        sharing_model = root.findtext(_tag("sharingModel")) or ""

        nodes.append(NodeFact(
            label=node_type,
            key_props={"qualifiedName": object_api_name},
            all_props={
                "qualifiedName": object_api_name,
                "apiName": object_api_name,
                "apiLabel": api_label,
                "sharingModel": sharing_model,
            },
            sourceFile=str(obj_xml_path), lineNumber=0, parserType="xml_object",
        ))

        # Parse inline <fields> elements if present
        for field_elem in root.findall(_tag("fields")):
            field_name = field_elem.findtext(_tag("fullName")) or ""
            if field_name:
                field_qname = f"{object_api_name}.{field_name}"
                field_type = field_elem.findtext(_tag("type")) or ""
                nodes.append(NodeFact(
                    label="SFField",
                    key_props={"qualifiedName": field_qname},
                    all_props={
                        "qualifiedName": field_qname,
                        "apiName": field_name,
                        "objectApiName": object_api_name,
                        "fieldType": field_type,
                    },
                    sourceFile=str(obj_xml_path), lineNumber=0, parserType="xml_object",
                ))

    # Parse fields/ subdirectory
    fields_dir = obj_dir_path / "fields"
    if fields_dir.exists():
        for field_file in sorted(fields_dir.glob("*.field-meta.xml")):
            try:
                fn, fe = parse_field_xml(str(field_file), object_api_name)
                nodes.extend(fn)
                edges.extend(fe)
            except ET.ParseError as exc:
                import logging
                logging.getLogger(__name__).warning("Failed to parse field XML %s: %s", field_file, exc)

    return nodes, edges


def parse_labels_xml(labels_path: str) -> tuple[list[NodeFact], list[EdgeFact]]:
    """Parse a .labels-meta.xml or .label-meta.xml file.

    .labels-meta.xml: contains multiple <labels> children
    .label-meta.xml: contains a single <CustomLabel> root
    """
    nodes: list[NodeFact] = []
    edges: list[EdgeFact] = []

    tree = ET.parse(labels_path)
    root = tree.getroot()

    # .labels-meta.xml: root is <CustomLabels>, children are <labels>
    if root.tag == _tag("CustomLabels"):
        for label_elem in root.findall(_tag("labels")):
            full_name = label_elem.findtext(_tag("fullName")) or ""
            label_value = label_elem.findtext(_tag("value")) or ""
            language = label_elem.findtext(_tag("language")) or "en_US"
            if full_name:
                nodes.append(NodeFact(
                    label="CustomLabel",
                    key_props={"qualifiedName": f"CustomLabel.{full_name}"},
                    all_props={
                        "qualifiedName": f"CustomLabel.{full_name}",
                        "apiName": full_name,
                        "value": label_value,
                        "language": language,
                    },
                    sourceFile=labels_path, lineNumber=0, parserType="xml_object",
                ))
    # .label-meta.xml: root is <CustomLabel> or namespace variant
    else:
        full_name = root.findtext(_tag("fullName")) or Path(labels_path).stem.replace(".label-meta", "")
        label_value = root.findtext(_tag("value")) or ""
        language = root.findtext(_tag("language")) or "en_US"
        if full_name:
            nodes.append(NodeFact(
                label="CustomLabel",
                key_props={"qualifiedName": f"CustomLabel.{full_name}"},
                all_props={
                    "qualifiedName": f"CustomLabel.{full_name}",
                    "apiName": full_name,
                    "value": label_value,
                    "language": language,
                },
                sourceFile=labels_path, lineNumber=0, parserType="xml_object",
            ))

    return nodes, edges


def parse_global_value_set_xml(gvs_path: str) -> tuple[list[NodeFact], list[EdgeFact]]:
    """Parse a .globalValueSet-meta.xml file."""
    nodes: list[NodeFact] = []
    edges: list[EdgeFact] = []
    tree = ET.parse(gvs_path)
    root = tree.getroot()
    full_name = root.findtext(_tag("fullName")) or Path(gvs_path).stem.replace(".globalValueSet-meta", "")
    label = root.findtext(_tag("masterLabel")) or full_name

    nodes.append(
        NodeFact(
            label="GlobalValueSet",
            key_props={"qualifiedName": full_name},
            all_props={"qualifiedName": full_name, "apiName": full_name, "apiLabel": label},
            sourceFile=gvs_path,
            lineNumber=0,
            parserType="xml_object",
        )
    )

    for value in root.findall(_tag("customValue")):
        val_name = value.findtext(_tag("fullName")) or ""
        val_label = value.findtext(_tag("label")) or val_name
        is_default = value.findtext(_tag("default")) == "true"
        if not val_name:
            continue
        val_qname = f"{full_name}.{val_name}"
        nodes.append(
            NodeFact(
                label="SFPicklistValue",
                key_props={"qualifiedName": val_qname},
                all_props={
                    "qualifiedName": val_qname,
                    "apiName": val_name,
                    "apiLabel": val_label,
                    "isDefault": is_default,
                    "globalValueSet": full_name,
                },
                sourceFile=gvs_path,
                lineNumber=0,
                parserType="xml_object",
            )
        )
        edges.append(
            EdgeFact(
                src_qualified_name=full_name,
                src_label="GlobalValueSet",
                rel_type="GLOBAL_VALUE_SET_HAS_VALUE",
                dst_qualified_name=val_qname,
                dst_label="SFPicklistValue",
                confidence=1.0,
                resolutionMethod="direct",
                edgeCategory="STRUCTURAL",
                contextSnippet=f"global value set value: {val_name}",
            )
        )
    return nodes, edges


def parse_custom_metadata_record_xml(record_path: str) -> tuple[list[NodeFact], list[EdgeFact]]:
    """Parse a customMetadata/*.md-meta.xml record file."""
    nodes: list[NodeFact] = []
    edges: list[EdgeFact] = []
    tree = ET.parse(record_path)
    root = tree.getroot()
    full_name = root.findtext(_tag("fullName")) or Path(record_path).stem.replace(".md-meta", "")
    if "." not in full_name:
        return nodes, edges
    type_api, _record_name = full_name.split(".", 1)
    type_qname = f"{type_api}__mdt" if not type_api.endswith("__mdt") else type_api

    nodes.append(
        NodeFact(
            label="CustomMetadataRecord",
            key_props={"qualifiedName": full_name},
            all_props={"qualifiedName": full_name, "typeQualifiedName": type_qname},
            sourceFile=record_path,
            lineNumber=0,
            parserType="xml_object",
        )
    )
    edges.append(
        EdgeFact(
            src_qualified_name=type_qname,
            src_label="CustomMetadataType",
            rel_type="CONTAINS_CHILD",
            dst_qualified_name=full_name,
            dst_label="CustomMetadataRecord",
            confidence=1.0,
            resolutionMethod="direct",
            edgeCategory="STRUCTURAL",
            contextSnippet=f"custom metadata record: {full_name}",
        )
    )
    return nodes, edges


class ObjectParser:
    """High-level entrypoint consumed by IngestionService (Plan 03-05)."""

    def parse_objects_dir(self, objects_dir: str) -> tuple[list[NodeFact], list[EdgeFact]]:
        """Parse all object subdirectories in an objects/ dir."""
        all_nodes: list[NodeFact] = []
        all_edges: list[EdgeFact] = []

        for obj_subdir in sorted(Path(objects_dir).iterdir()):
            if obj_subdir.is_dir():
                try:
                    n, e = parse_object_dir(str(obj_subdir))
                    all_nodes.extend(n)
                    all_edges.extend(e)
                except Exception as exc:
                    import logging
                    logging.getLogger(__name__).warning("Failed to parse object dir %s: %s", obj_subdir, exc)

        # Parse .labels-meta.xml files if present at the labels/ level
        for labels_file in sorted(Path(objects_dir).parent.glob("labels/*.labels-meta.xml")):
            try:
                n, e = parse_labels_xml(str(labels_file))
                all_nodes.extend(n)
                all_edges.extend(e)
            except Exception as exc:
                import logging
                logging.getLogger(__name__).warning("Failed to parse labels XML %s: %s", labels_file, exc)

        return all_nodes, all_edges
