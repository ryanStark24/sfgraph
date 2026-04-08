"""Tests for Vlocity/OmniStudio parser (VLO-01 through VLO-07 baseline)."""
from __future__ import annotations

import json
from pathlib import Path

import pytest

from sfgraph.ingestion.constants import EDGE_CATEGORIES
from sfgraph.parser.vlocity_registry import SUPPORTED_VLOCITY_DATAPACK_TYPES
from sfgraph.parser.vlocity_parser import (
    VlocityParser,
    is_vlocity_datapack_file,
    parse_vlocity_json,
    parse_vlocity_json_detailed,
)


def _write_json(path: Path, payload: dict):
    path.write_text(json.dumps(payload, indent=2), encoding="utf-8")


def test_integration_procedure_nodes_and_merge_field_edges(tmp_path):
    file = tmp_path / "AccountIntegrationProcedure_DataPack.json"
    _write_json(
        file,
        {
            "VlocityDataPackType": "IntegrationProcedure",
            "Name": "AccountIP",
            "Version": 1,
            "IsActive": True,
            "Steps": [
                {"Name": "FetchAccount", "Type": "DataRaptor Extract"},
                {"Name": "TransformData", "Type": "DataRaptor Transform"},
            ],
            "Template": "Use %FetchAccount:Status__c% to decide",
        },
    )

    nodes, edges = parse_vlocity_json(str(file))
    assert any(n.label == "IntegrationProcedure" and n.key_props["qualifiedName"] == "AccountIP" for n in nodes)
    assert any(n.label == "IPElement" and n.key_props["qualifiedName"] == "AccountIP.FetchAccount" for n in nodes)
    assert any(e.rel_type == "HAS_STEP" and e.dst_qualified_name == "AccountIP.FetchAccount" for e in edges)
    assert any(e.rel_type == "REFERENCES_STEP_OUTPUT" for e in edges)


def test_integration_procedure_merge_fields_create_ip_variables(tmp_path):
    file = tmp_path / "ServiceabilityIP_DataPack.json"
    _write_json(
        file,
        {
            "VlocityDataPackType": "IntegrationProcedure",
            "Name": "ServiceabilityIP",
            "Steps": [{"Name": "FetchOrder", "Type": "DataRaptor Extract"}],
            "Template": "%FetchOrder:Status__c% + %accessId:value%",
        },
    )

    nodes, edges = parse_vlocity_json(str(file))
    assert any(n.label == "IPVariable" and n.key_props["qualifiedName"] == "ServiceabilityIP.var.accessId" for n in nodes)
    assert any(
        e.rel_type == "READS_VALUE"
        and e.dst_label == "IPVariable"
        and e.dst_qualified_name == "ServiceabilityIP.var.accessId"
        for e in edges
    )
    assert any(
        e.rel_type == "REFERENCES_STEP_OUTPUT"
        and e.dst_qualified_name == "ServiceabilityIP.FetchOrder"
        for e in edges
    )


def test_integration_procedure_step_level_references_emit_calls(tmp_path):
    file = tmp_path / "OrderNowIP_DataPack.json"
    _write_json(
        file,
        {
            "VlocityDataPackType": "IntegrationProcedure",
            "Name": "OrderNowIP",
            "Steps": [
                {
                    "Name": "ApplyAdjustments",
                    "Type": "DataRaptor Post",
                    "DataRaptorName": "DROrderNowUpdateAttributes",
                }
            ],
        },
    )

    _, edges = parse_vlocity_json(str(file))
    assert any(
        e.rel_type == "CALLS"
        and e.src_label == "IPElement"
        and e.src_qualified_name == "OrderNowIP.ApplyAdjustments"
        and e.dst_label == "DataRaptor"
        and e.dst_qualified_name == "DROrderNowUpdateAttributes"
        for e in edges
    )


def test_dataraptor_extract_reads_fields(tmp_path):
    file = tmp_path / "AccountExtract_DataPack.json"
    _write_json(
        file,
        {
            "VlocityDataPackType": "DataRaptor",
            "DataRaptorType": "Extract",
            "Name": "AccountExtract",
            "SourceObject": "Account",
            "SourceFields": ["Id", "Name", "Status__c"],
        },
    )

    nodes, edges = parse_vlocity_json(str(file))
    assert any(n.label == "DataRaptor" for n in nodes)
    reads = [e for e in edges if e.rel_type == "DR_READS"]
    assert reads
    dst = {e.dst_qualified_name for e in reads}
    assert "Account.Name" in dst
    assert "Account.Status__c" in dst


def test_dataraptor_load_writes_fields(tmp_path):
    file = tmp_path / "AccountLoad_DataPack.json"
    _write_json(
        file,
        {
            "VlocityDataPackType": "DataRaptor",
            "DataRaptorType": "Load",
            "Name": "AccountLoad",
            "DestinationObject": "Account",
            "DestinationFields": ["Status__c"],
        },
    )

    _, edges = parse_vlocity_json(str(file))
    writes = [e for e in edges if e.rel_type == "DR_WRITES"]
    assert writes
    assert any(e.dst_qualified_name == "Account.Status__c" for e in writes)


def test_dataraptor_transform_edges(tmp_path):
    file = tmp_path / "AccountTransform_DataPack.json"
    _write_json(
        file,
        {
            "VlocityDataPackType": "DataRaptor",
            "DataRaptorType": "Transform",
            "Name": "AccountTransform",
            "InputDataRaptor": "AccountExtract",
            "Mappings": [
                {
                    "SourceObject": "Account",
                    "SourceField": "Status__c",
                    "DestinationObject": "Case",
                    "DestinationField": "Status__c",
                }
            ],
        },
    )

    _, edges = parse_vlocity_json(str(file))
    assert any(e.rel_type == "DR_TRANSFORMS" and e.dst_qualified_name == "AccountExtract" for e in edges)
    assert any(e.rel_type == "DR_READS" and "Account.Status__c" in e.dst_qualified_name for e in edges)
    assert any(e.rel_type == "DR_WRITES" and "Case.Status__c" in e.dst_qualified_name for e in edges)


def test_namespace_normalizer_replaces_placeholder(tmp_path):
    file = tmp_path / "NsLoad_DataPack.json"
    _write_json(
        file,
        {
            "VlocityDataPackType": "DataRaptor",
            "DataRaptorType": "Load",
            "Name": "NsLoad",
            "DestinationObject": "%vlocity_namespace%__Cart__c",
            "DestinationFields": ["%vlocity_namespace%__Status__c"],
        },
    )

    _, edges = parse_vlocity_json(str(file), namespace="omnistudio")
    writes = [e for e in edges if e.rel_type == "DR_WRITES"]
    assert writes
    assert any("omnistudio__Cart__c.omnistudio__Status__c" == e.dst_qualified_name for e in writes)


def test_omniscript_calls_apex_and_ip(tmp_path):
    file = tmp_path / "AccountOmniScript_DataPack.json"
    _write_json(
        file,
        {
            "VlocityDataPackType": "OmniScript",
            "Name": "AccountOS",
            "Type": "Service",
            "SubType": "Account",
            "IsActive": True,
            "ApexActions": [{"ClassName": "AccountService"}],
            "IntegrationProcedures": ["AccountIP"],
        },
    )

    nodes, edges = parse_vlocity_json(str(file))
    assert any(n.label == "OmniScript" and n.key_props["qualifiedName"] == "AccountOS" for n in nodes)
    assert any(e.rel_type == "CALLS" and e.dst_label == "ApexClass" and e.dst_qualified_name == "AccountService" for e in edges)
    assert any(e.rel_type == "CALLS" and e.dst_label == "IntegrationProcedure" and e.dst_qualified_name == "AccountIP" for e in edges)


def test_parse_datapacks_dir(tmp_path):
    _write_json(
        tmp_path / "IP.json",
        {"VlocityDataPackType": "IntegrationProcedure", "Name": "IP1", "Steps": []},
    )
    _write_json(
        tmp_path / "DR.json",
        {
            "VlocityDataPackType": "DataRaptor",
            "DataRaptorType": "Extract",
            "Name": "DR1",
            "SourceObject": "Account",
            "SourceFields": ["Name"],
        },
    )

    parser = VlocityParser(namespace="vlocity_cmt")
    nodes, edges = parser.parse_datapacks_dir(str(tmp_path))
    assert any(n.label == "IntegrationProcedure" for n in nodes)
    assert any(n.label == "DataRaptor" for n in nodes)
    assert edges


def test_all_edge_categories_valid(tmp_path):
    file = tmp_path / "DR2.json"
    _write_json(
        file,
        {
            "VlocityDataPackType": "DataRaptor",
            "DataRaptorType": "Extract",
            "Name": "DR2",
            "SourceObject": "Account",
            "SourceFields": ["Name"],
        },
    )

    _, edges = parse_vlocity_json(str(file))
    for edge in edges:
        assert edge.edgeCategory in EDGE_CATEGORIES


def test_unknown_vlocity_pack_type_still_emits_generic_node(tmp_path):
    file = tmp_path / "ProductChildItems_DataPack.json"
    _write_json(
        file,
        {
            "VlocityDataPackType": "ProductChildItems",
            "Name": "FacultyAddon",
            "ApexClassName": "CatalogService",
            "IntegrationProcedureName": "SyncCatalog",
        },
    )

    nodes, edges = parse_vlocity_json(str(file))
    assert any(n.label == "VlocityDataPack" for n in nodes)
    assert any(n.all_props.get("dataPackType") == "ProductChildItems" for n in nodes)
    assert any(e.rel_type == "CALLS" and e.dst_label == "ApexClass" and e.dst_qualified_name == "CatalogService" for e in edges)
    assert any(
        e.rel_type == "CALLS"
        and e.dst_label == "IntegrationProcedure"
        and e.dst_qualified_name == "SyncCatalog"
        for e in edges
    )


def test_vlocity_card_uses_specialized_component_node(tmp_path):
    file = tmp_path / "AccountCard_DataPack.json"
    _write_json(
        file,
        {
            "VlocityDataPackType": "VlocityCard",
            "Name": "AccountCard",
            "IntegrationProcedureName": "LoadAccountCard",
            "ApexClassName": "AccountCardController",
        },
    )

    nodes, edges, meta = parse_vlocity_json_detailed(str(file))
    assert meta.outcome == "parsed_specialized"
    assert meta.node_label == "VlocityCard"
    assert any(n.label == "VlocityCard" and n.key_props["qualifiedName"] == "VlocityCard.AccountCard" for n in nodes)
    assert any(e.rel_type == "CALLS" and e.dst_label == "IntegrationProcedure" for e in edges)


def test_vlocity_detailed_outcomes_report_non_datapack_and_invalid_json(tmp_path):
    invalid = tmp_path / "broken_DataPack.json"
    invalid.write_text("{not-json", encoding="utf-8")
    _, _, invalid_meta = parse_vlocity_json_detailed(str(invalid))
    assert invalid_meta.outcome == "invalid_json"

    support = tmp_path / "vlocity" / "support.json"
    support.parent.mkdir(parents=True, exist_ok=True)
    _write_json(support, {"name": "support-json-without-pack-type"})
    _, _, support_meta = parse_vlocity_json_detailed(str(support))
    assert support_meta.outcome == "non_datapack_json"


def test_vlocity_candidate_detection_accepts_generic_datapack_names(tmp_path):
    candidate = tmp_path / "files" / "ProductChildItems_DataPack.json"
    candidate.parent.mkdir(parents=True, exist_ok=True)
    candidate.write_text("{}", encoding="utf-8")
    assert is_vlocity_datapack_file(candidate) is True


def test_supported_non_object_vlocity_arrays_are_parsed(tmp_path):
    file = tmp_path / "Offer_PromotionItems.json"
    file.write_text(
        json.dumps(
            [
                {
                    "Name": "PromoItemA",
                    "DataRaptorName": "PromoLoadDR",
                }
            ]
        ),
        encoding="utf-8",
    )

    nodes, edges, meta = parse_vlocity_json_detailed(str(file))
    assert meta.outcome == "parsed_specialized"
    assert meta.pack_type == "PromotionItems"
    assert any(n.label == "VlocityDataPack" and n.key_props["qualifiedName"] == "PromotionItems.Offer" for n in nodes)
    assert any(e.rel_type == "CONTAINS_CHILD" for e in edges)
    assert any(
        e.rel_type == "CALLS"
        and e.dst_label == "DataRaptor"
        and e.dst_qualified_name == "PromoLoadDR"
        for e in edges
    )


def test_supported_vlocity_registry_matches_upstream_inventory_size():
    assert len(SUPPORTED_VLOCITY_DATAPACK_TYPES) == 55
    assert "DataRaptor" in SUPPORTED_VLOCITY_DATAPACK_TYPES
    assert "OmniScript" in SUPPORTED_VLOCITY_DATAPACK_TYPES
    assert "VlocityUITemplate" in SUPPORTED_VLOCITY_DATAPACK_TYPES
