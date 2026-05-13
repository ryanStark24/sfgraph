"""Flow XML parser for Salesforce metadata.

Parses .flow-meta.xml files and returns NodeFact + EdgeFact lists consumed
by IngestionService. Uses xml.etree.ElementTree (stdlib).
"""
from __future__ import annotations

import re
from pathlib import Path
import xml.etree.ElementTree as ET

from sfgraph.ingestion.models import EdgeFact, NodeFact

NS = "http://soap.sforce.com/2006/04/metadata"
_LABEL_REF_RE = re.compile(r"\$Label\.(\w+)")


def _tag(name: str) -> str:
    return f"{{{NS}}}{name}"


def parse_flow_xml(path: str) -> tuple[list[NodeFact], list[EdgeFact]]:
    """Parse one .flow-meta.xml file into NodeFact and EdgeFact lists."""
    nodes: list[NodeFact] = []
    edges: list[EdgeFact] = []

    api_name = Path(path).name.replace(".flow-meta.xml", "")

    tree = ET.parse(path)
    root = tree.getroot()

    label = root.findtext(_tag("label")) or api_name
    process_type = root.findtext(_tag("processType")) or ""
    status = root.findtext(_tag("status")) or ""
    is_active = status.lower() == "active"
    api_version = root.findtext(_tag("apiVersion")) or ""

    trigger_type: str | None = None
    trigger_object: str | None = None
    record_trigger_type: str | None = None

    start = root.find(_tag("start"))
    if start is not None:
        trigger_type = start.findtext(_tag("triggerType"))
        trigger_object = start.findtext(_tag("object"))
        record_trigger_type = start.findtext(_tag("recordTriggerType"))

    nodes.append(
        NodeFact(
            label="Flow",
            key_props={"qualifiedName": api_name},
            all_props={
                "qualifiedName": api_name,
                "apiName": api_name,
                "apiLabel": label,
                "processType": process_type,
                "triggerType": trigger_type,
                "triggerObject": trigger_object,
                "recordTriggerType": record_trigger_type,
                "isActive": is_active,
                "apiVersion": api_version,
            },
            sourceFile=path,
            lineNumber=0,
            parserType="xml_flow",
        )
    )

    if trigger_type == "PlatformEvent" and trigger_object:
        edges.append(
            EdgeFact(
                src_qualified_name=api_name,
                src_label="Flow",
                rel_type="SUBSCRIBES_TO_EVENT",
                dst_qualified_name=trigger_object,
                dst_label="PlatformEvent",
                confidence=1.0,
                resolutionMethod="direct",
                edgeCategory="DATA_FLOW",
                contextSnippet=f"Flow {api_name} subscribes to {trigger_object}",
            )
        )

    for op_tag in ("recordLookups", "recordCreates", "recordUpdates", "recordDeletes"):
        for elem in root.findall(_tag(op_tag)):
            elem_name = elem.findtext(_tag("name")) or ""
            elem_object = elem.findtext(_tag("object")) or trigger_object or ""
            elem_qname = f"{api_name}.{elem_name}" if elem_name else api_name

            nodes.append(
                NodeFact(
                    label="FlowElement",
                    key_props={"qualifiedName": elem_qname},
                    all_props={
                        "qualifiedName": elem_qname,
                        "name": elem_name,
                        "flowApiName": api_name,
                        "opType": op_tag,
                        "sObjectType": elem_object,
                    },
                    sourceFile=path,
                    lineNumber=0,
                    parserType="xml_flow",
                )
            )

            read_op = op_tag == "recordLookups"
            write_op = op_tag in ("recordCreates", "recordUpdates")

            for ia in elem.findall(_tag("inputAssignments")):
                field = ia.findtext(_tag("field")) or ""
                if field and elem_object:
                    edges.append(
                        EdgeFact(
                            src_qualified_name=api_name,
                            src_label="Flow",
                            rel_type="FLOW_WRITES_FIELD" if write_op else "FLOW_READS_FIELD",
                            dst_qualified_name=f"{elem_object}.{field}",
                            dst_label="SFField",
                            confidence=0.95,
                            resolutionMethod="direct",
                            edgeCategory="DATA_FLOW",
                            contextSnippet=f"{op_tag} {elem_name}: {field}",
                        )
                    )

            for oa in elem.findall(_tag("outputAssignments")):
                field = oa.findtext(_tag("field")) or ""
                if field and elem_object:
                    edges.append(
                        EdgeFact(
                            src_qualified_name=api_name,
                            src_label="Flow",
                            rel_type="FLOW_READS_FIELD",
                            dst_qualified_name=f"{elem_object}.{field}",
                            dst_label="SFField",
                            confidence=0.95,
                            resolutionMethod="direct",
                            edgeCategory="DATA_FLOW",
                            contextSnippet=f"{op_tag} {elem_name} output: {field}",
                        )
                    )

            if read_op:
                for flt in elem.findall(_tag("filters")):
                    field = flt.findtext(_tag("field")) or ""
                    if field and elem_object:
                        edges.append(
                            EdgeFact(
                                src_qualified_name=api_name,
                                src_label="Flow",
                                rel_type="FLOW_READS_FIELD",
                                dst_qualified_name=f"{elem_object}.{field}",
                                dst_label="SFField",
                                confidence=0.9,
                                resolutionMethod="direct",
                                edgeCategory="DATA_FLOW",
                                contextSnippet=f"{op_tag} {elem_name} filter: {field}",
                            )
                        )

    for dec in root.findall(_tag("decisions")):
        dec_name = dec.findtext(_tag("name")) or ""
        for rule in dec.findall(_tag("rules")):
            rule_name = rule.findtext(_tag("name")) or ""
            for cond in rule.findall(_tag("conditions")):
                left_ref = cond.findtext(_tag("leftValueReference")) or ""
                right_val_elem = cond.find(_tag("rightValue"))
                right_string = None
                if right_val_elem is not None:
                    right_string = right_val_elem.findtext(_tag("stringValue"))

                if left_ref.startswith("$Record."):
                    field_api = left_ref.replace("$Record.", "")
                    dst_qname = f"{trigger_object}.{field_api}" if trigger_object else field_api
                    edges.append(
                        EdgeFact(
                            src_qualified_name=api_name,
                            src_label="Flow",
                            rel_type="FLOW_READS_FIELD",
                            dst_qualified_name=dst_qname,
                            dst_label="SFField",
                            confidence=0.9,
                            resolutionMethod="direct",
                            edgeCategory="DATA_FLOW",
                            contextSnippet=f"Decision {dec_name}.{rule_name}: {left_ref}",
                        )
                    )
                    if right_string:
                        edges.append(
                            EdgeFact(
                                src_qualified_name=api_name,
                                src_label="Flow",
                                rel_type="FLOW_READS_VALUE",
                                dst_qualified_name=f"{dst_qname}.{right_string}",
                                dst_label="SFPicklistValue",
                                confidence=0.6,
                                resolutionMethod="direct",
                                edgeCategory="DATA_FLOW",
                                contextSnippet=f"{left_ref} == '{right_string}'",
                            )
                        )

    for ac in root.findall(_tag("actionCalls")):
        action_name = ac.findtext(_tag("actionName")) or ""
        action_type = ac.findtext(_tag("actionType")) or ""
        ac_name = ac.findtext(_tag("name")) or ""

        if action_type == "apex" and action_name:
            edges.append(
                EdgeFact(
                    src_qualified_name=api_name,
                    src_label="Flow",
                    rel_type="FLOW_CALLS_APEX",
                    dst_qualified_name=action_name,
                    dst_label="ApexClass",
                    confidence=0.95,
                    resolutionMethod="direct",
                    edgeCategory="CONTROL_FLOW",
                    contextSnippet=f"actionCalls/{ac_name}: {action_name}",
                )
            )

        if (action_type in ("publishPlatformEvent", "publish") or action_name.endswith("__e")) and action_name:
            edges.append(
                EdgeFact(
                    src_qualified_name=api_name,
                    src_label="Flow",
                    rel_type="PUBLISHES_EVENT",
                    dst_qualified_name=action_name,
                    dst_label="PlatformEvent",
                    confidence=0.9,
                    resolutionMethod="direct",
                    edgeCategory="DATA_FLOW",
                    contextSnippet=f"publishPlatformEvent: {action_name}",
                )
            )

    for sf_elem in root.findall(_tag("subflows")):
        flow_name = sf_elem.findtext(_tag("flowName")) or ""
        sf_name = sf_elem.findtext(_tag("name")) or ""
        if flow_name:
            edges.append(
                EdgeFact(
                    src_qualified_name=api_name,
                    src_label="Flow",
                    rel_type="FLOW_CALLS_SUBFLOW",
                    dst_qualified_name=flow_name,
                    dst_label="Flow",
                    confidence=1.0,
                    resolutionMethod="direct",
                    edgeCategory="CONTROL_FLOW",
                    contextSnippet=f"subflow/{sf_name}: {flow_name}",
                )
            )

    all_text = ET.tostring(root, encoding="unicode")
    label_refs = set(_LABEL_REF_RE.findall(all_text))
    for label_name in sorted(label_refs):
        edges.append(
            EdgeFact(
                src_qualified_name=api_name,
                src_label="Flow",
                rel_type="FLOW_RESOLVES_LABEL",
                dst_qualified_name=f"CustomLabel.{label_name}",
                dst_label="CustomLabel",
                confidence=1.0,
                resolutionMethod="direct",
                edgeCategory="CONFIG",
                contextSnippet=f"$Label.{label_name}",
            )
        )

    return nodes, edges


class FlowParser:
    """High-level parser for all flow files under a directory."""

    def parse_flows_dir(self, flows_dir: str) -> tuple[list[NodeFact], list[EdgeFact]]:
        all_nodes: list[NodeFact] = []
        all_edges: list[EdgeFact] = []

        for flow_file in sorted(Path(flows_dir).glob("*.flow-meta.xml")):
            try:
                nodes, edges = parse_flow_xml(str(flow_file))
                all_nodes.extend(nodes)
                all_edges.extend(edges)
            except ET.ParseError:
                continue

        return all_nodes, all_edges
