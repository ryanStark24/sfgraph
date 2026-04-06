"""Smoke tests for sfgraph CLI parser wiring."""
from __future__ import annotations

import types
import subprocess
import sys

from sfgraph import cli


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
    assert "progress" in result.stdout


def test_cli_query_help_exits_zero():
    result = subprocess.run(
        [sys.executable, "-m", "sfgraph.cli", "query", "--help"],
        capture_output=True,
        text=True,
    )
    assert result.returncode == 0
    assert "question" in result.stdout


def test_cli_serve_runs_without_asyncio_wrapping(monkeypatch):
    called = {"run": 0}

    def fake_run():
        called["run"] += 1

    monkeypatch.setitem(sys.modules, "sfgraph.server", types.SimpleNamespace(mcp=types.SimpleNamespace(run=fake_run)))

    result = cli.main(["serve"])

    assert result == 0
    assert called["run"] == 1


def test_cli_progress_help_exits_zero():
    result = subprocess.run(
        [sys.executable, "-m", "sfgraph.cli", "progress", "--help"],
        capture_output=True,
        text=True,
    )
    assert result.returncode == 0
    assert "--data-dir" in result.stdout
