from __future__ import annotations

import json
from types import SimpleNamespace

import pytest

from sfgraph.ingestion.org_metadata import (
    SalesforceOrgMetadataClient,
    extract_count_from_sf_query,
    normalize_datapack_type_name,
    split_matching_key_fields,
)


def _completed_process(*, returncode: int = 0, stdout: str = "{}", stderr: str = ""):
    return SimpleNamespace(returncode=returncode, stdout=stdout, stderr=stderr)


def test_extract_count_from_sf_query():
    assert extract_count_from_sf_query({"result": {"records": [{"total": 4}]}}) == 4


def test_split_matching_key_fields_accepts_comma_or_semicolon():
    assert split_matching_key_fields("Name, Type__c") == ["Name", "Type__c"]
    assert split_matching_key_fields("Name;Type__c") == ["Name", "Type__c"]


def test_normalize_datapack_type_name_trims_suffixes():
    assert normalize_datapack_type_name("CustomThing__mdt") == "CustomThing"
    assert normalize_datapack_type_name("CustomThing__c") == "CustomThing"


def test_org_metadata_client_loads_vlocity_rule_overrides(monkeypatch: pytest.MonkeyPatch):
    def fake_run(command, **kwargs):
        joined = " ".join(command)
        if "VlocityDataPackConfiguration__mdt" in joined:
            return _completed_process(
                stdout=json.dumps(
                    {
                        "result": {
                            "records": [
                                {
                                    "DeveloperName": "CustomThing",
                                    "SObjectType__c": "CustomThing__c",
                                    "QueryFields__c": "Name,Type__c",
                                }
                            ]
                        }
                    }
                )
            )
        if "DRMatchingKey__mdt" in joined:
            return _completed_process(
                stdout=json.dumps(
                    {
                        "result": {
                            "records": [
                                {
                                    "ObjectAPIName__c": "CustomThing__c",
                                    "MatchingKeyFields__c": "Name,Type__c",
                                    "ReturnKeyField__c": "Name",
                                }
                            ]
                        }
                    }
                )
            )
        raise AssertionError(f"unexpected command: {joined}")

    monkeypatch.setattr("sfgraph.ingestion.org_metadata.subprocess.run", fake_run)

    client = SalesforceOrgMetadataClient("my-org")
    overrides = client.load_vlocity_rule_overrides()
    assert overrides == [
        {
            "datapack_type": "CustomThing",
            "primary_sobject_type": "CustomThing__c",
            "query_signature": "Name,Type__c",
            "matching_key_fields": ["Name", "Type__c"],
            "return_key_field": "Name",
        }
    ]
