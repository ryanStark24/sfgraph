"""Parsers for Salesforce metadata types outside object/flow/aura/lwc.

This module intentionally keeps each metadata family narrow and readable so the
IngestionService can route more file types without growing more special cases.
"""
from __future__ import annotations

from pathlib import Path
import xml.etree.ElementTree as ET

from sfgraph.ingestion.models import EdgeFact, NodeFact

NS = "http://soap.sforce.com/2006/04/metadata"


def _tag(name: str) -> str:
    return f"{{{NS}}}{name}"


def _bool_text(parent: ET.Element, name: str) -> bool:
    return (parent.findtext(_tag(name)) or "").strip().lower() == "true"


def _clean_endpoint(endpoint: str) -> str:
    value = endpoint.strip()
    if not value:
        return ""
    if "?" in value:
        value = value.split("?", 1)[0]
    return value.rstrip("/")


def _strip_known_suffix(file_name: str, suffix: str) -> str:
    if not file_name.endswith(suffix):
        raise ValueError(f"Unsupported metadata file: {file_name}")
    return file_name[: -len(suffix)]


def _qualified_name_from_folder(path: str, suffix: str) -> str:
    file_path = Path(path)
    base_name = _strip_known_suffix(file_path.name, suffix)
    parent_name = file_path.parent.name
    if parent_name and parent_name not in {".", ""}:
        return f"{parent_name}.{base_name}"
    return base_name


def parse_permission_metadata_xml(path: str) -> tuple[list[NodeFact], list[EdgeFact]]:
    tree = ET.parse(path)
    root = tree.getroot()
    source_path = str(Path(path))
    file_name = Path(path).name
    if file_name.endswith(".permissionset-meta.xml"):
        label = "PermissionSet"
        api_name = file_name[: -len(".permissionset-meta.xml")]
    elif file_name.endswith(".profile-meta.xml"):
        label = "Profile"
        api_name = file_name[: -len(".profile-meta.xml")]
    else:
        raise ValueError(f"Unsupported permission metadata file: {path}")

    display_label = root.findtext(_tag("label")) or api_name
    description = root.findtext(_tag("description")) or ""

    nodes: list[NodeFact] = [
        NodeFact(
            label=label,
            key_props={"qualifiedName": api_name},
            all_props={
                "qualifiedName": api_name,
                "apiName": api_name,
                "apiLabel": display_label,
                "description": description,
            },
            sourceFile=source_path,
            lineNumber=0,
            parserType="xml_metadata",
        )
    ]
    edges: list[EdgeFact] = []

    for perm in root.findall(_tag("objectPermissions")):
        object_name = (perm.findtext(_tag("object")) or "").strip()
        if not object_name:
            continue
        edges.append(
            EdgeFact(
                src_qualified_name=api_name,
                src_label=label,
                rel_type="GRANTS_OBJECT_ACCESS",
                dst_qualified_name=object_name,
                dst_label="SFObject",
                confidence=1.0,
                resolutionMethod="direct",
                edgeCategory="CONFIG",
                contextSnippet=(
                    f"read={_bool_text(perm, 'allowRead')} edit={_bool_text(perm, 'allowEdit')} "
                    f"create={_bool_text(perm, 'allowCreate')} delete={_bool_text(perm, 'allowDelete')}"
                ),
            )
        )

    for perm in root.findall(_tag("fieldPermissions")):
        field_name = (perm.findtext(_tag("field")) or "").strip()
        if not field_name:
            continue
        edges.append(
            EdgeFact(
                src_qualified_name=api_name,
                src_label=label,
                rel_type="GRANTS_FIELD_ACCESS",
                dst_qualified_name=field_name,
                dst_label="SFField",
                confidence=1.0,
                resolutionMethod="direct",
                edgeCategory="CONFIG",
                contextSnippet=f"readable={_bool_text(perm, 'readable')} editable={_bool_text(perm, 'editable')}",
            )
        )

    for access in root.findall(_tag("classAccesses")):
        apex_class = (access.findtext(_tag("apexClass")) or "").strip()
        if not apex_class or not _bool_text(access, "enabled"):
            continue
        edges.append(
            EdgeFact(
                src_qualified_name=api_name,
                src_label=label,
                rel_type="GRANTS_APEX_ACCESS",
                dst_qualified_name=apex_class,
                dst_label="ApexClass",
                confidence=1.0,
                resolutionMethod="direct",
                edgeCategory="CONFIG",
                contextSnippet="class access enabled",
            )
        )

    return nodes, edges


def parse_named_credential_xml(path: str) -> tuple[list[NodeFact], list[EdgeFact]]:
    tree = ET.parse(path)
    root = tree.getroot()
    source_path = str(Path(path))
    file_name = Path(path).name
    if file_name.endswith(".namedCredential-meta.xml"):
        api_name = file_name[: -len(".namedCredential-meta.xml")]
    else:
        raise ValueError(f"Unsupported named credential file: {path}")

    label = root.findtext(_tag("label")) or api_name
    endpoint = root.findtext(_tag("endpoint")) or ""
    external_credential = root.findtext(_tag("externalCredential")) or ""
    protocol = root.findtext(_tag("protocol")) or ""

    nodes = [
        NodeFact(
            label="NamedCredential",
            key_props={"qualifiedName": api_name},
            all_props={
                "qualifiedName": api_name,
                "apiName": api_name,
                "apiLabel": label,
                "endpoint": endpoint,
                "endpointHost": _clean_endpoint(endpoint),
                "externalCredential": external_credential,
                "protocol": protocol,
            },
            sourceFile=source_path,
            lineNumber=0,
            parserType="xml_metadata",
        )
    ]
    edges: list[EdgeFact] = []
    if external_credential.strip():
        edges.append(
            EdgeFact(
                src_qualified_name=api_name,
                src_label="NamedCredential",
                rel_type="USES_EXTERNAL_CREDENTIAL",
                dst_qualified_name=external_credential.strip(),
                dst_label="ExternalNamespace",
                confidence=0.9,
                resolutionMethod="direct",
                edgeCategory="CONFIG",
                contextSnippet=f"external credential: {external_credential.strip()}",
            )
        )
    return nodes, edges


def parse_workflow_xml(path: str) -> tuple[list[NodeFact], list[EdgeFact]]:
    tree = ET.parse(path)
    root = tree.getroot()
    source_path = str(Path(path))
    object_api_name = _strip_known_suffix(Path(path).name, ".workflow-meta.xml")

    nodes: list[NodeFact] = []
    edges: list[EdgeFact] = []

    for rule_elem in root.findall(_tag("rules")):
        rule_name = (rule_elem.findtext(_tag("fullName")) or "").strip()
        if not rule_name:
            continue
        rule_qname = f"{object_api_name}.{rule_name}"
        trigger_type = (rule_elem.findtext(_tag("triggerType")) or "").strip()
        active = _bool_text(rule_elem, "active")

        nodes.append(
            NodeFact(
                label="WorkflowRule",
                key_props={"qualifiedName": rule_qname},
                all_props={
                    "qualifiedName": rule_qname,
                    "apiName": rule_name,
                    "objectApiName": object_api_name,
                    "active": active,
                    "triggerType": trigger_type,
                },
                sourceFile=source_path,
                lineNumber=0,
                parserType="xml_metadata",
            )
        )
        edges.append(
            EdgeFact(
                src_qualified_name=object_api_name,
                src_label="SFObject",
                rel_type="CONTAINS_CHILD",
                dst_qualified_name=rule_qname,
                dst_label="WorkflowRule",
                confidence=1.0,
                resolutionMethod="direct",
                edgeCategory="STRUCTURAL",
                contextSnippet=f"workflow rule: {rule_name}",
            )
        )

        for criteria in rule_elem.findall(_tag("criteriaItems")):
            field_name = (criteria.findtext(_tag("field")) or "").strip()
            if not field_name:
                continue
            edges.append(
                EdgeFact(
                    src_qualified_name=rule_qname,
                    src_label="WorkflowRule",
                    rel_type="WORKFLOW_REFERENCES_FIELD",
                    dst_qualified_name=f"{object_api_name}.{field_name}",
                    dst_label="SFField",
                    confidence=0.95,
                    resolutionMethod="direct",
                    edgeCategory="CONFIG",
                    contextSnippet=f"criteria field: {field_name}",
                )
            )

    for update_elem in root.findall(_tag("fieldUpdates")):
        update_name = (update_elem.findtext(_tag("fullName")) or "").strip()
        field_name = (update_elem.findtext(_tag("field")) or "").strip()
        if not update_name or not field_name:
            continue
        action_qname = f"{object_api_name}.{update_name}"
        nodes.append(
            NodeFact(
                label="WorkflowAction",
                key_props={"qualifiedName": action_qname},
                all_props={
                    "qualifiedName": action_qname,
                    "apiName": update_name,
                    "objectApiName": object_api_name,
                    "actionType": "fieldUpdate",
                    "targetField": field_name,
                },
                sourceFile=source_path,
                lineNumber=0,
                parserType="xml_metadata",
            )
        )
        edges.append(
            EdgeFact(
                src_qualified_name=object_api_name,
                src_label="SFObject",
                rel_type="CONTAINS_CHILD",
                dst_qualified_name=action_qname,
                dst_label="WorkflowAction",
                confidence=1.0,
                resolutionMethod="direct",
                edgeCategory="STRUCTURAL",
                contextSnippet=f"workflow field update: {update_name}",
            )
        )
        edges.append(
            EdgeFact(
                src_qualified_name=action_qname,
                src_label="WorkflowAction",
                rel_type="WORKFLOW_WRITES_FIELD",
                dst_qualified_name=f"{object_api_name}.{field_name}",
                dst_label="SFField",
                confidence=1.0,
                resolutionMethod="direct",
                edgeCategory="CONFIG",
                contextSnippet=f"workflow updates field: {field_name}",
            )
        )

    return nodes, edges


def parse_report_xml(path: str) -> tuple[list[NodeFact], list[EdgeFact]]:
    tree = ET.parse(path)
    root = tree.getroot()
    source_path = str(Path(path))
    report_qname = _qualified_name_from_folder(path, ".report-meta.xml")
    report_type = (root.findtext(_tag("reportType")) or "").strip()
    name = report_qname.split(".")[-1]

    nodes = [
        NodeFact(
            label="Report",
            key_props={"qualifiedName": report_qname},
            all_props={
                "qualifiedName": report_qname,
                "apiName": name,
                "folder": Path(path).parent.name,
                "reportType": report_type,
            },
            sourceFile=source_path,
            lineNumber=0,
            parserType="xml_metadata",
        )
    ]
    return nodes, []


def parse_dashboard_xml(path: str) -> tuple[list[NodeFact], list[EdgeFact]]:
    tree = ET.parse(path)
    root = tree.getroot()
    source_path = str(Path(path))
    dashboard_qname = _qualified_name_from_folder(path, ".dashboard-meta.xml")
    name = dashboard_qname.split(".")[-1]

    nodes = [
        NodeFact(
            label="Dashboard",
            key_props={"qualifiedName": dashboard_qname},
            all_props={
                "qualifiedName": dashboard_qname,
                "apiName": name,
                "folder": Path(path).parent.name,
                "title": root.findtext(_tag("title")) or name,
            },
            sourceFile=source_path,
            lineNumber=0,
            parserType="xml_metadata",
        )
    ]
    edges: list[EdgeFact] = []
    for component in root.findall(_tag("dashboardChartComponents")):
        report_name = (component.findtext(_tag("report")) or "").strip()
        if not report_name:
            continue
        edges.append(
            EdgeFact(
                src_qualified_name=dashboard_qname,
                src_label="Dashboard",
                rel_type="DASHBOARD_USES_REPORT",
                dst_qualified_name=report_name,
                dst_label="Report",
                confidence=0.95,
                resolutionMethod="direct",
                edgeCategory="CONFIG",
                contextSnippet=f"dashboard report: {report_name}",
            )
        )
    return nodes, edges
