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
