"""Tests for ApexExtractor and DynamicAccessorRegistry."""
from __future__ import annotations

import json
import subprocess
from pathlib import Path

import pytest

from sfgraph.ingestion.constants import EDGE_CATEGORIES
from sfgraph.parser.apex_extractor import ApexExtractor
from sfgraph.parser.dynamic_accessor import DynamicAccessorRegistry

FIXTURE_CLS = Path("tests/fixtures/metadata/classes/AccountService.cls")
WORKER_JS = Path("src/sfgraph/parser/worker/worker.js")


def get_worker_payload(cls_path: Path) -> dict:
    """Call worker.js directly and return parsed payload."""
    content = cls_path.read_text(encoding="utf-8")
    msg = json.dumps(
        {
            "requestId": "test-1",
            "grammar": "apex",
            "filePath": str(cls_path),
            "fileContent": content,
        }
    )
    result = subprocess.run(
        ["node", str(WORKER_JS)],
        input=msg + "\n",
        capture_output=True,
        text=True,
        timeout=30,
        check=False,
    )
    assert result.returncode == 0, result.stderr
    assert result.stdout.strip(), f"No stdout from worker, stderr={result.stderr}"
    raw_stdout = result.stdout.strip()
    if raw_stdout.startswith("@@SFGRAPH_LEN@@"):
        parts = raw_stdout.splitlines()
        raw_stdout = "\n".join(parts[1:]).strip()
    resp = json.loads(raw_stdout)
    assert resp["ok"], f"Worker returned error: {resp.get('error')}"
    return resp["payload"]


@pytest.fixture(scope="module")
def account_payload() -> dict:
    return get_worker_payload(FIXTURE_CLS)


@pytest.fixture(scope="module")
def extracted(account_payload: dict):
    extractor = ApexExtractor()
    nodes, edges = extractor.extract(account_payload, str(FIXTURE_CLS))
    return nodes, edges


def test_apex_class_node_exists(extracted):
    nodes, _ = extracted
    cls_nodes = [n for n in nodes if n.label == "ApexClass"]
    assert len(cls_nodes) == 1
    assert cls_nodes[0].key_props["qualifiedName"] == "AccountService"
    assert cls_nodes[0].all_props["isTest"] is False


def test_apex_class_source_attribution(extracted):
    nodes, _ = extracted
    cls_node = next(n for n in nodes if n.label == "ApexClass")
    assert cls_node.sourceFile == str(FIXTURE_CLS)
    assert cls_node.parserType == "apex_cst"
    assert cls_node.lineNumber > 0
    assert "sourceFile" in cls_node.all_props


def test_apex_method_nodes_present(extracted):
    nodes, _ = extracted
    method_nodes = [n for n in nodes if n.label == "ApexMethod"]
    method_names = {n.all_props["name"] for n in method_nodes}
    assert "getById" in method_names
    assert "updateStatus" in method_names
    assert "getAllAccounts" in method_names


def test_apex_method_visibility_and_static(extracted):
    nodes, _ = extracted
    get_by_id = next(
        n for n in nodes if n.label == "ApexMethod" and n.all_props["name"] == "getById"
    )
    assert get_by_id.all_props["visibility"] == "public"
    assert get_by_id.all_props["isStatic"] is True
    assert get_by_id.all_props["returnType"] == "Account"


def test_apex_method_qualified_name(extracted):
    nodes, _ = extracted
    get_by_id = next(
        n for n in nodes if n.label == "ApexMethod" and n.all_props["name"] == "getById"
    )
    assert get_by_id.key_props["qualifiedName"] == "AccountService.getById"


def test_soql_produces_queries_object_edge(extracted):
    _, edges = extracted
    soql_edges = [e for e in edges if e.rel_type == "QUERIES_OBJECT"]
    assert soql_edges
    targets = {e.dst_qualified_name for e in soql_edges}
    assert "Account" in targets


def test_dml_produces_dml_on_edges(extracted):
    _, edges = extracted
    dml_edges = [e for e in edges if e.rel_type == "DML_ON"]
    assert dml_edges
    # DML targets should represent probable SObjects, not DML keywords.
    assert all(e.dst_qualified_name.lower() not in {"update", "insert", "delete"} for e in dml_edges)


def test_cross_class_call_produces_calls_edge(extracted):
    _, edges = extracted
    calls_edges = [e for e in edges if e.rel_type == "CALLS"]
    targets = {e.dst_qualified_name for e in calls_edges}
    assert "ContactService" in targets
    for edge in calls_edges:
        assert edge.edgeCategory == "CONTROL_FLOW"


def test_label_ref_produces_reads_label_edge(extracted):
    _, edges = extracted
    label_edges = [e for e in edges if e.rel_type == "READS_LABEL"]
    assert label_edges
    assert any("Account_Status_Label" in e.dst_qualified_name for e in label_edges)
    for edge in label_edges:
        assert edge.edgeCategory == "CONFIG"
        assert edge.confidence == 1.0


def test_event_bus_publish_produces_edge(extracted):
    _, edges = extracted
    event_edges = [e for e in edges if e.rel_type == "PUBLISHES_EVENT"]
    assert event_edges
    assert any("Account_Updated__e" in e.dst_qualified_name for e in event_edges)
    for edge in event_edges:
        assert edge.edgeCategory == "DATA_FLOW"


def test_picklist_comparison_produces_candidate_edge(extracted):
    _, edges = extracted
    picklist_edges = [e for e in edges if e.rel_type == "READS_VALUE"]
    assert picklist_edges
    for edge in picklist_edges:
        assert edge.confidence <= 0.5
        assert edge.edgeCategory == "DATA_FLOW"


def test_all_edge_categories_valid(extracted):
    _, edges = extracted
    for edge in edges:
        assert edge.edgeCategory in EDGE_CATEGORIES


def test_dynamic_accessor_registry_loads():
    registry = DynamicAccessorRegistry()
    assert len(registry._index) > 0


def test_dynamic_accessor_fflib_selector_match():
    registry = DynamicAccessorRegistry()
    results = registry.match(
        class_name="fflib_SObjectSelector",
        method_name="selectById",
        src_qualified_name="AccountSelector",
        src_label="ApexClass",
    )
    assert len(results) == 1
    assert results[0].rel_type == "READS_FIELD"
    assert results[0].edgeCategory == "DATA_FLOW"


def test_dynamic_accessor_no_match_returns_empty():
    registry = DynamicAccessorRegistry()
    results = registry.match(
        class_name="UnknownClass",
        method_name="unknownMethod",
        src_qualified_name="AnyClass",
        src_label="ApexClass",
    )
    assert results == []


def test_dml_keyword_target_is_ignored():
    extractor = ApexExtractor()
    payload = {
        "hasError": False,
        "nodes": [{"nodeType": "ApexClass", "name": "Demo"}],
        "potential_refs": [
            {
                "refType": "DML",
                "targetType": "",
                "dmlType": "update",
                "contextSnippet": "update recs;",
            }
        ],
    }
    _, edges = extractor.extract(payload, "Demo.cls")
    assert not [e for e in edges if e.rel_type == "DML_ON"]


def test_regex_inferred_field_edges_from_local_assignments(tmp_path: Path):
    cls_file = tmp_path / "OrderExtensionEngine.cls"
    cls_file.write_text(
        "public class OrderExtensionEngine {\n"
        "  public static void apply() {\n"
        "    OrderItem oi = new OrderItem();\n"
        "    oi.Service_Id__c = 'abc';\n"
        "    String value = oi.Service_Id__c;\n"
        "  }\n"
        "}\n",
        encoding="utf-8",
    )
    payload = {
        "hasError": False,
        "nodes": [{"nodeType": "ApexClass", "name": "OrderExtensionEngine"}],
        "potential_refs": [],
    }
    extractor = ApexExtractor()
    _, edges = extractor.extract(payload, str(cls_file))
    writes = [e for e in edges if e.rel_type == "WRITES_FIELD" and e.dst_qualified_name == "OrderItem.Service_Id__c"]
    reads = [e for e in edges if e.rel_type == "READS_FIELD" and e.dst_qualified_name == "OrderItem.Service_Id__c"]
    assert writes
    assert reads
