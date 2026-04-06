"""Smoke tests for sfgraph CLI parser wiring."""
from __future__ import annotations

import subprocess
import sys


def test_cli_help_exits_zero():
    result = subprocess.run(
        [sys.executable, "-m", "sfgraph.cli", "--help"],
        capture_output=True,
        text=True,
    )
    assert result.returncode == 0
    assert "sfgraph" in result.stdout
    assert "ingest" in result.stdout
    assert "refresh" in result.stdout


def test_cli_query_help_exits_zero():
    result = subprocess.run(
        [sys.executable, "-m", "sfgraph.cli", "query", "--help"],
        capture_output=True,
        text=True,
    )
    assert result.returncode == 0
    assert "question" in result.stdout
