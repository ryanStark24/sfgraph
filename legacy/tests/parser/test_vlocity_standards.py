from __future__ import annotations

import json
from pathlib import Path

from sfgraph.vlocity_standards import VlocityStandardsCore, matching_key_candidates


def test_vlocity_standards_bundle_loads_baseline_and_local_types(tmp_path: Path):
    known = tmp_path / "vlocity" / "DataRaptor" / "Known_DataPack.json"
    custom = tmp_path / "vlocity" / "CustomThing" / "CustomThing_DataPack.json"
    known.parent.mkdir(parents=True, exist_ok=True)
    custom.parent.mkdir(parents=True, exist_ok=True)
    known.write_text(json.dumps({"VlocityDataPackType": "DataRaptor", "Name": "ExtractAccount"}), encoding="utf-8")
    custom.write_text(json.dumps({"VlocityDataPackType": "CustomThing", "Name": "Mine"}), encoding="utf-8")

    bundle = VlocityStandardsCore().resolve_bundle(tmp_path)

    assert bundle.get("DataRaptor") is not None
    assert bundle.get("DataRaptor").matching_key_fields == ("Name",)
    assert "CustomThing" in bundle.custom_types_discovered
    assert "CustomThing" in bundle.unmapped_datapack_types


def test_matching_key_candidates_reads_inline_vlocity_metadata():
    payload = {
        "Nested": [
            {
                "VlocityMatchingKeyObject": {
                    "Name": "OrderNow",
                    "Type": "Promo",
                }
            }
        ]
    }

    assert matching_key_candidates(payload) == ["Name", "Type"]


def test_vlocity_standards_critical_suffixes_can_extend_non_object_family(tmp_path: Path):
    baseline = {
        "critical_file_suffixes": {
            "CustomArrayItems": {
                "node_label": "CustomArrayItem",
                "rel_type": "HAS_CUSTOM_ARRAY_ITEM",
            }
        },
        "rules": {},
    }
    bundle = VlocityStandardsCore(baseline_payload=baseline).resolve_bundle(tmp_path)
    assert bundle.critical_file_suffixes["CustomArrayItems"]["node_label"] == "CustomArrayItem"
