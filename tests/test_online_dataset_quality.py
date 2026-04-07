"""Optional online dataset quality checks (Apex + Vlocity real repos)."""
from __future__ import annotations

import json
import os
import subprocess
import sys
from pathlib import Path

import pytest


def _run(cmd: list[str], *, cwd: Path | None = None) -> str:
    proc = subprocess.run(cmd, cwd=str(cwd) if cwd else None, check=True, capture_output=True, text=True)
    return proc.stdout.strip()


def _parse_json_output(stdout: str) -> dict:
    text = stdout.strip()
    if not text:
        return {}
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        pass
    for line in reversed(text.splitlines()):
        line = line.strip()
        if not line:
            continue
        try:
            return json.loads(line)
        except json.JSONDecodeError:
            continue
    raise ValueError(f"Unable to parse JSON from command output: {text[:400]}")


@pytest.mark.online_dataset
def test_online_dataset_ingest_and_acceptance_suite(tmp_path: Path):
    if os.getenv("SFGRAPH_ONLINE_DATASET_TESTS") != "1":
        pytest.skip("Set SFGRAPH_ONLINE_DATASET_TESTS=1 to run online dataset quality tests.")

    repo_url = os.getenv("SFGRAPH_ONLINE_REPO_URL", "https://github.com/Soforce/vlocity-ex.git")
    clone_dir = tmp_path / "repo"
    data_dir = tmp_path / "data"
    suite_path = tmp_path / "suite.json"

    _run(["git", "clone", "--depth", "1", repo_url, str(clone_dir)])

    suite = [
        {
            "id": "field_population",
            "question": "using sfgraph, tell me where Service_Id__c is populated from",
            "expected_mode": "analyze_field",
        },
        {
            "id": "component_token_population",
            "question": "In class OrderNowUpdateAttribute, where is accessId populated? show method and source file.",
            "expected_mode": "analyze_component",
        },
        {
            "id": "object_insert_lifecycle",
            "question": "using sfgraph, tell me where what happens when a quotelineitem is inserted",
            "expected_mode": "analyze_object_event",
        },
        {
            "id": "impact_analysis",
            "question": "using sfgraph, what breaks if I change QuoteLineItemTriggerHelper",
            "expected_mode": "analyze_change",
        },
    ]
    suite_path.write_text(json.dumps(suite, indent=2), encoding="utf-8")

    ingest_out = _run(
        [
            sys.executable,
            "-m",
            "sfgraph.cli",
            "ingest",
            str(clone_dir),
            "--data-dir",
            str(data_dir),
            "--mode",
            "graph_only",
        ],
        cwd=clone_dir,
    )
    ingest_payload = _parse_json_output(ingest_out)

    parser_stats = ingest_payload.get("parser_stats", {})
    apex_stats = parser_stats.get("apex", {})
    vlocity_stats = parser_stats.get("vlocity", {})
    assert ingest_payload.get("total_files", 0) > 0
    assert apex_stats.get("parsed_files", 0) > 0
    assert (vlocity_stats.get("parsed_files", 0) + vlocity_stats.get("skipped_files", 0)) > 0

    acceptance_out = _run(
        [
            sys.executable,
            "-m",
            "sfgraph.cli",
            "acceptance",
            "--data-dir",
            str(data_dir),
            "--suite",
            str(suite_path),
        ],
        cwd=clone_dir,
    )
    acceptance_payload = _parse_json_output(acceptance_out)
    summary = acceptance_payload.get("summary", {})

    assert summary.get("total_cases") == 4
    assert summary.get("expectation_count") == 4
    assert summary.get("expectation_pass_rate", 0.0) >= 0.75
    assert summary.get("avg_duration_ms", 0.0) > 0
