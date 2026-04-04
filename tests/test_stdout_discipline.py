# tests/test_stdout_discipline.py
"""CI assertion: importing sfgraph.server must emit zero bytes to stdout.

MCP stdio transport is fatally corrupted by any stdout output.
This test runs as a subprocess to capture real fd-level stdout.
"""
import subprocess
import sys
import os


def test_server_import_emits_nothing_to_stdout():
    """Importing sfgraph.server must produce zero stdout bytes."""
    result = subprocess.run(
        ["uv", "run", "python", "-c", "import sfgraph.server"],
        capture_output=True,
        cwd=os.getcwd(),
    )
    assert result.returncode == 0, f"Import failed: {result.stderr.decode()}"
    assert result.stdout == b"", (
        f"STDOUT POLLUTION DETECTED: {result.stdout!r}\n"
        "Any stdout output corrupts MCP stdio transport."
    )


def test_logging_call_after_server_import_stays_on_stderr():
    """A logging.info() call after server import must not touch stdout."""
    result = subprocess.run(
        [
            "uv", "run", "python", "-c",
            "import sfgraph.server; import logging; logging.getLogger('test').info('hello')"
        ],
        capture_output=True,
        cwd=os.getcwd(),
    )
    assert result.returncode == 0, f"Script failed: {result.stderr.decode()}"
    assert result.stdout == b"", (
        f"STDOUT POLLUTION from logging: {result.stdout!r}"
    )
