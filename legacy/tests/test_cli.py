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
    assert "vectorize" in result.stdout
    assert "daemon" in result.stdout
    assert "acceptance" in result.stdout
    assert "selftest" in result.stdout


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


def test_cli_daemon_runs_main(monkeypatch):
    called = {"main": 0, "argv": None}

    def fake_main(argv):
        called["main"] += 1
        called["argv"] = argv
        return 0

    monkeypatch.setitem(sys.modules, "sfgraph.daemon", types.SimpleNamespace(main=fake_main))

    result = cli.main(["daemon", "--port", "31337"])

    assert result == 0
    assert called["main"] == 1
    assert "--port" in called["argv"]


def test_cli_progress_help_exits_zero():
    result = subprocess.run(
        [sys.executable, "-m", "sfgraph.cli", "progress", "--help"],
        capture_output=True,
        text=True,
    )
    assert result.returncode == 0
    assert "--data-dir" in result.stdout


def test_cli_ingest_help_includes_discovery_filters():
    result = subprocess.run(
        [sys.executable, "-m", "sfgraph.cli", "ingest", "--help"],
        capture_output=True,
        text=True,
    )
    assert result.returncode == 0
    assert "--include" in result.stdout
    assert "--exclude" in result.stdout
    assert "--org-alias" in result.stdout
    assert "--enrich-org" in result.stdout


def test_cli_refresh_help_includes_discovery_filters():
    result = subprocess.run(
        [sys.executable, "-m", "sfgraph.cli", "refresh", "--help"],
        capture_output=True,
        text=True,
    )
    assert result.returncode == 0
    assert "--include" in result.stdout
    assert "--exclude" in result.stdout
    assert "--org-alias" in result.stdout
    assert "--enrich-org" in result.stdout


def test_cli_acceptance_help_exits_zero():
    result = subprocess.run(
        [sys.executable, "-m", "sfgraph.cli", "acceptance", "--help"],
        capture_output=True,
        text=True,
    )
    assert result.returncode == 0
    assert "--suite" in result.stdout


def test_cli_selftest_help_exits_zero():
    result = subprocess.run(
        [sys.executable, "-m", "sfgraph.cli", "selftest", "--help"],
        capture_output=True,
        text=True,
    )
    assert result.returncode == 0
    assert "--suite" in result.stdout
    assert "--poll-interval" in result.stdout
