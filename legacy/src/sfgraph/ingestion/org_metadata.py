"""Salesforce CLI-backed org metadata helpers for ingestion enrichment."""
from __future__ import annotations

import json
import subprocess
from dataclasses import dataclass
from typing import Any


def extract_count_from_sf_query(payload: dict[str, Any]) -> int | None:
    result = payload.get("result")
    if not isinstance(result, dict):
        return None
    records = result.get("records")
    if not isinstance(records, list) or not records:
        return None
    first = records[0]
    if not isinstance(first, dict):
        return None
    for key in ("expr0", "total", "count"):
        value = first.get(key)
        if isinstance(value, int):
            return value
        if isinstance(value, str) and value.isdigit():
            return int(value)
    for value in first.values():
        if isinstance(value, int):
            return value
        if isinstance(value, str) and value.isdigit():
            return int(value)
    return None


def extract_sf_records(payload: dict[str, Any]) -> list[dict[str, Any]]:
    result = payload.get("result")
    if not isinstance(result, dict):
        return []
    records = result.get("records")
    if not isinstance(records, list):
        return []
    return [record for record in records if isinstance(record, dict)]


def split_matching_key_fields(raw_value: Any) -> list[str]:
    if isinstance(raw_value, list):
        return [str(item).strip() for item in raw_value if str(item).strip()]
    if not isinstance(raw_value, str):
        return []
    normalized = raw_value.replace(";", ",")
    return [item.strip() for item in normalized.split(",") if item.strip()]


def normalize_datapack_type_name(value: Any) -> str:
    normalized = str(value or "").strip()
    if normalized.endswith("__mdt"):
        normalized = normalized[:-5]
    if normalized.endswith("__c"):
        normalized = normalized[:-3]
    return normalized


@dataclass
class SalesforceOrgMetadataClient:
    alias: str

    def query_json(self, soql: str, *, tooling: bool = False, timeout: int = 20) -> dict[str, Any] | None:
        try:
            command = ["sf", "data", "query", "--target-org", self.alias, "--query", soql, "--json"]
            if tooling:
                command.insert(5, "--use-tooling-api")
            proc = subprocess.run(command, check=False, capture_output=True, text=True, timeout=timeout)
            if proc.returncode != 0:
                return None
            payload = json.loads(proc.stdout or "{}")
            return payload if isinstance(payload, dict) else None
        except Exception:
            return None

    def query_records(self, soql: str, *, tooling: bool = False, timeout: int = 20) -> list[dict[str, Any]]:
        payload = self.query_json(soql, tooling=tooling, timeout=timeout)
        if payload is None:
            return []
        return extract_sf_records(payload)

    def query_count(self, soql: str, *, tooling: bool = False, timeout: int = 20) -> int | None:
        payload = self.query_json(soql, tooling=tooling, timeout=timeout)
        if payload is None:
            return None
        return extract_count_from_sf_query(payload)

    def load_vlocity_rule_overrides(self) -> list[dict[str, Any]]:
        datapack_queries = (
            "SELECT DeveloperName, MasterLabel, DataPackType__c, SObjectType__c, QueryFields__c FROM VlocityDataPackConfiguration__mdt",
            "SELECT DeveloperName, MasterLabel FROM VlocityDataPackConfiguration__mdt",
        )
        matching_queries = (
            "SELECT DeveloperName, MasterLabel, ObjectAPIName__c, MatchingKeyFields__c, MatchingKeyObject__c, ReturnKeyField__c FROM DRMatchingKey__mdt",
            "SELECT DeveloperName, MasterLabel FROM DRMatchingKey__mdt",
        )

        datapack_rows: list[dict[str, Any]] = []
        for query in datapack_queries:
            datapack_rows = self.query_records(query)
            if datapack_rows:
                break

        matching_rows: list[dict[str, Any]] = []
        for query in matching_queries:
            matching_rows = self.query_records(query)
            if matching_rows:
                break

        overrides: dict[str, dict[str, Any]] = {}
        for row in datapack_rows:
            datapack_type = normalize_datapack_type_name(
                row.get("DataPackType__c") or row.get("DeveloperName") or row.get("MasterLabel")
            )
            if not datapack_type:
                continue
            overrides[datapack_type] = {
                "datapack_type": datapack_type,
                "primary_sobject_type": str(row.get("SObjectType__c") or ""),
                "query_signature": str(row.get("QueryFields__c") or row.get("MasterLabel") or ""),
            }

        for row in matching_rows:
            datapack_type = normalize_datapack_type_name(
                row.get("ObjectAPIName__c")
                or row.get("MatchingKeyObject__c")
                or row.get("DeveloperName")
                or row.get("MasterLabel")
            )
            if not datapack_type:
                continue
            target = overrides.setdefault(datapack_type, {"datapack_type": datapack_type})
            target["primary_sobject_type"] = str(
                target.get("primary_sobject_type")
                or row.get("ObjectAPIName__c")
                or row.get("MatchingKeyObject__c")
                or ""
            )
            target["matching_key_fields"] = split_matching_key_fields(row.get("MatchingKeyFields__c"))
            target["return_key_field"] = str(row.get("ReturnKeyField__c") or "")

        return [payload for _, payload in sorted(overrides.items())]
