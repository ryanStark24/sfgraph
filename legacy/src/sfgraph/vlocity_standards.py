"""Rule-driven Vlocity standards loading.

The implementation is intentionally spec-first and Python-native. We use
bundled baseline metadata plus local file hints and optional org enrichment to
produce one normalized rule bundle that parsers can consume.
"""
from __future__ import annotations

from dataclasses import asdict, dataclass, field
import json
from pathlib import Path
from typing import Any

import yaml

from sfgraph.contracts import StandardsProvider


@dataclass(frozen=True)
class VlocityRule:
    datapack_type: str
    primary_sobject_type: str = ""
    matching_key_fields: tuple[str, ...] = ()
    return_key_field: str = ""
    query_signature: str = ""
    required_settings: tuple[str, ...] = ()
    source_provenance: str = "bundled_baseline"
    confidence: float = 0.5

    def describe(self) -> dict[str, Any]:
        return asdict(self)


@dataclass(frozen=True)
class VlocityRuleBundle:
    rules_by_type: dict[str, VlocityRule]
    critical_file_suffixes: dict[str, dict[str, str]]
    custom_types_discovered: tuple[str, ...] = ()
    unmapped_datapack_types: tuple[str, ...] = ()
    source_chain: tuple[str, ...] = ()

    def get(self, datapack_type: str | None) -> VlocityRule | None:
        if not datapack_type:
            return None
        return self.rules_by_type.get(datapack_type)

    def describe(self) -> dict[str, Any]:
        return {
            "source_chain": list(self.source_chain),
            "custom_types_discovered": list(self.custom_types_discovered),
            "unmapped_datapack_types": list(self.unmapped_datapack_types),
            "rules_by_type": {
                key: rule.describe()
                for key, rule in sorted(self.rules_by_type.items())
            },
            "critical_file_suffixes": self.critical_file_suffixes,
        }


def _baseline_path() -> Path:
    return Path(__file__).resolve().parent / "config" / "vlocity_standards_baseline.yaml"


def _load_baseline_payload() -> dict[str, Any]:
    return yaml.safe_load(_baseline_path().read_text(encoding="utf-8")) or {}


def _normalize_rule(datapack_type: str, payload: dict[str, Any], provenance: str, confidence: float) -> VlocityRule:
    return VlocityRule(
        datapack_type=datapack_type,
        primary_sobject_type=str(payload.get("primary_sobject_type") or ""),
        matching_key_fields=tuple(str(item) for item in payload.get("matching_key_fields", []) if str(item)),
        return_key_field=str(payload.get("return_key_field") or ""),
        query_signature=str(payload.get("query_signature") or ""),
        required_settings=tuple(str(item) for item in payload.get("required_settings", []) if str(item)),
        source_provenance=provenance,
        confidence=confidence,
    )


class VlocityStandardsCore(StandardsProvider):
    """Resolve normalized rule bundles from baseline, local files, and org hints."""

    def __init__(self, baseline_payload: dict[str, Any] | None = None) -> None:
        self._baseline_payload = baseline_payload or _load_baseline_payload()

    def resolve_bundle(
        self,
        export_dir: str | Path,
        *,
        org_alias: str | None = None,
        org_context: dict[str, Any] | None = None,
    ) -> VlocityRuleBundle:
        root = Path(export_dir).expanduser().resolve()
        baseline = dict(self._baseline_payload)
        rules_payload = baseline.get("rules", {}) if isinstance(baseline.get("rules"), dict) else {}
        rules_by_type = {
            datapack_type: _normalize_rule(datapack_type, payload, "bundled_baseline", 0.65)
            for datapack_type, payload in rules_payload.items()
            if isinstance(payload, dict)
        }

        discovered: dict[str, VlocityRule] = {}
        custom_types: set[str] = set()
        unmapped: set[str] = set()
        if root.exists():
            for candidate in root.rglob("*.json"):
                if "vlocity" not in {part.lower() for part in candidate.parts}:
                    continue
                datapack_type = self._infer_local_datapack_type(candidate)
                if not datapack_type:
                    continue
                if datapack_type in rules_by_type:
                    continue
                custom_types.add(datapack_type)
                discovered[datapack_type] = VlocityRule(
                    datapack_type=datapack_type,
                    primary_sobject_type=datapack_type,
                    source_provenance="local_datapack_inference",
                    confidence=0.35,
                )
                if candidate.name.endswith(".json"):
                    unmapped.add(datapack_type)

        if isinstance(org_context, dict):
            for datapack_type, payload in self._iter_org_rule_payloads(org_context):
                rules_by_type[datapack_type] = _normalize_rule(
                    datapack_type,
                    payload,
                    f"org:{org_alias or 'default'}",
                    0.9,
                )
                custom_types.add(datapack_type)
                unmapped.discard(datapack_type)

        rules_by_type.update(discovered)
        source_chain = ["bundled_baseline", "local_datapack_inference"]
        if org_alias or org_context:
            source_chain.append("org_metadata")
        critical_suffixes = baseline.get("critical_file_suffixes", {})
        return VlocityRuleBundle(
            rules_by_type=rules_by_type,
            critical_file_suffixes=critical_suffixes if isinstance(critical_suffixes, dict) else {},
            custom_types_discovered=tuple(sorted(custom_types)),
            unmapped_datapack_types=tuple(sorted(unmapped)),
            source_chain=tuple(source_chain),
        )

    @staticmethod
    def _infer_local_datapack_type(path: Path) -> str | None:
        try:
            payload = json.loads(path.read_text(encoding="utf-8"))
        except Exception:
            return None
        if isinstance(payload, dict):
            for key in ("VlocityDataPackType", "DataPackType", "Type", "type"):
                value = payload.get(key)
                if isinstance(value, str) and value.strip():
                    return value.strip()
        stem = path.stem
        if "_" in stem:
            suffix = stem.rsplit("_", 1)[-1]
            if suffix:
                return suffix
        return path.parent.name or None

    @staticmethod
    def _iter_org_rule_payloads(org_context: dict[str, Any]) -> list[tuple[str, dict[str, Any]]]:
        raw = org_context.get("vlocity_rule_overrides")
        if not isinstance(raw, list):
            return []
        out: list[tuple[str, dict[str, Any]]] = []
        for item in raw:
            if not isinstance(item, dict):
                continue
            datapack_type = str(item.get("datapack_type") or "").strip()
            if not datapack_type:
                continue
            out.append((datapack_type, item))
        return out


def matching_key_candidates(payload: Any) -> list[str]:
    """Extract inline Vlocity matching-key field names from arbitrary payloads."""
    hits: list[str] = []

    def _walk(value: Any) -> None:
        if isinstance(value, dict):
            for key, item in value.items():
                if key in {"VlocityMatchingKeyObject", "VlocityLookupMatchingKeyObject"} and isinstance(item, dict):
                    for field_name in item.keys():
                        normalized = str(field_name).strip()
                        if normalized and normalized not in hits:
                            hits.append(normalized)
                _walk(item)
        elif isinstance(value, list):
            for item in value:
                _walk(item)

    _walk(payload)
    return hits
