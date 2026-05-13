from sfgraph.mcp_selftest import render_selftest_markdown


def test_render_selftest_markdown_includes_core_sections():
    payload = {
        "meta": {
            "export_dir": "/tmp/repo",
            "data_dir": "/tmp/data",
            "suite_path": "/tmp/suite.json",
            "job_id": "job-1",
            "ingest_mode": "graph_only",
        },
        "ingest": {"state": "completed", "elapsed_seconds": 12.34},
        "latency": {"analyze_median_ms": 50.0, "analyze_p95_ms": 100.0, "native_search_median_ms": 20.0},
        "quality": {
            "expected_mode_pass_rate": 1.0,
            "semantic_fallback_count": 0,
            "low_confidence_count": 1,
            "avg_evidence_quality_score": 0.6,
        },
        "cost": {"total_tokens_est_total": 1234, "avg_tokens_est_per_case": 205.7},
        "cases": [
            {
                "id": "c1",
                "expected_mode": "field_writes",
                "actual_mode": "field_writes",
                "mode_match": True,
                "latency_ms": 42.0,
                "evidence_quality_score": 0.8,
                "semantic_fallback": False,
            }
        ],
    }
    report = render_selftest_markdown(payload)
    assert "# SFGraph Selftest Report" in report
    assert "## Run Meta" in report
    assert "## Quality" in report
    assert "## Cost (Estimated)" in report
    assert "| c1 | field_writes | field_writes | True | 42.0 | 0.8 | False |" in report
