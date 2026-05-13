"""
Tests for Node.js worker.js IPC protocol (POOL-01, POOL-02, POOL-05).

Tests are integration-style: they spawn the actual worker.js subprocess and
verify the framed JSON protocol over stdin/stdout.
"""
import asyncio
import json
import os
import pathlib
import subprocess
import sys

import pytest

# Paths
PROJECT_ROOT = pathlib.Path(__file__).parent.parent.parent
WORKER_JS = PROJECT_ROOT / "src" / "sfgraph" / "parser" / "worker" / "worker.js"
FIXTURES = pathlib.Path(__file__).parent / "fixtures"
NODE_BIN = "/opt/homebrew/opt/node@22/bin/node"
RESPONSE_PREFIX = b"@@SFGRAPH_LEN@@"

SIMPLE_CLS_CONTENT = (FIXTURES / "simple.cls").read_text()
BROKEN_CLS_CONTENT = (FIXTURES / "broken.cls").read_text()


def _parse_framed_responses(stdout: bytes) -> list[dict]:
    responses: list[dict] = []
    cursor = 0
    total = len(stdout)
    while cursor < total:
        if stdout[cursor:cursor + len(RESPONSE_PREFIX)] != RESPONSE_PREFIX:
            raise AssertionError(f"Unexpected worker frame at byte {cursor}: {stdout[cursor:cursor+50]!r}")
        newline = stdout.find(b"\n", cursor)
        if newline < 0:
            raise AssertionError("Missing frame header newline")
        length = int(stdout[cursor + len(RESPONSE_PREFIX):newline].decode())
        start = newline + 1
        end = start + length
        responses.append(json.loads(stdout[start:end].decode()))
        cursor = end
    return responses


def _send_request(requests: list[dict], timeout: int = 10) -> list[dict]:
    """Spawn worker.js, send newline-delimited requests, collect framed responses."""
    input_data = ("\n".join(json.dumps(r) for r in requests) + "\n").encode()
    result = subprocess.run(
        [NODE_BIN, str(WORKER_JS)],
        input=input_data,
        capture_output=True,
        timeout=timeout,
        cwd=str(PROJECT_ROOT),
    )
    return _parse_framed_responses(result.stdout)


def test_worker_js_exists():
    """worker.js must exist at expected path."""
    assert WORKER_JS.exists(), f"worker.js not found at {WORKER_JS}"


def test_ping_pong():
    """Ping request returns pong with matching requestId."""
    responses = _send_request([{"requestId": "test-ping-1", "type": "ping"}])
    assert len(responses) == 1
    assert responses[0]["type"] == "pong"
    assert responses[0]["requestId"] == "test-ping-1"


def test_parse_valid_apex_returns_ok_true():
    """Valid Apex file returns ok:true with payload."""
    req = {
        "requestId": "test-parse-1",
        "grammar": "apex",
        "filePath": str(FIXTURES / "simple.cls"),
    }
    responses = _send_request([req])
    assert len(responses) == 1
    resp = responses[0]
    assert resp["requestId"] == "test-parse-1"
    assert resp["ok"] is True
    assert resp["payload"] is not None
    assert resp["payload"]["hasError"] is False


def test_parse_broken_apex_returns_parse_error():
    """Apex with syntax errors returns ok:false with error:parse_error."""
    req = {
        "requestId": "test-broken-1",
        "grammar": "apex",
        "filePath": str(FIXTURES / "broken.cls"),
    }
    responses = _send_request([req])
    assert len(responses) == 1
    resp = responses[0]
    assert resp["requestId"] == "test-broken-1"
    assert resp["ok"] is False
    assert resp["error"] == "parse_error"
    assert resp["payload"]["filePath"].endswith("broken.cls")
    assert isinstance(resp["payload"]["fileSizeBytes"], int)
    assert "contextSnippet" in resp["payload"]


def test_multiple_requests_correlated_by_request_id():
    """Multiple requests are processed and responses have matching requestIds."""
    requests = [
        {"requestId": "multi-1", "type": "ping"},
        {
            "requestId": "multi-2",
            "grammar": "apex",
            "filePath": str(FIXTURES / "simple.cls"),
        },
    ]
    responses = _send_request(requests)
    assert len(responses) == 2
    by_id = {r["requestId"]: r for r in responses}
    assert by_id["multi-1"]["type"] == "pong"
    assert by_id["multi-2"]["ok"] is True


def test_parse_valid_apex_still_supports_inline_content():
    """Worker remains backward compatible with inline fileContent callers."""
    req = {
        "requestId": "test-inline-1",
        "grammar": "apex",
        "filePath": "simple.cls",
        "fileContent": SIMPLE_CLS_CONTENT,
    }
    responses = _send_request([req])
    assert len(responses) == 1
    assert responses[0]["ok"] is True


def test_parse_large_inline_apex_uses_framed_response():
    """Large payloads should round-trip without newline chunk limits."""
    methods = "\n".join(
        f"    public void method{i}() {{ Integer x = {i}; }}" for i in range(2500)
    )
    large_cls = f"public class HugeInlineClass {{\n{methods}\n}}"
    req = {
        "requestId": "test-large-inline",
        "grammar": "apex",
        "filePath": "HugeInlineClass.cls",
        "fileContent": large_cls,
    }
    responses = _send_request([req], timeout=20)
    assert len(responses) == 1
    assert responses[0]["ok"] is True
    assert responses[0]["payload"]["hasError"] is False


def test_parse_apex_tolerates_stray_prefix_before_docblock():
    """Apex exports with stray leading punctuation before comments should still parse."""
    content = "-/**\n * Header\n */\npublic class PrefixedDocblockClass {\n    public void run() {}\n}\n"
    req = {
        "requestId": "test-prefixed-docblock",
        "grammar": "apex",
        "filePath": "PrefixedDocblockClass.cls",
        "fileContent": content,
    }
    responses = _send_request([req])
    assert len(responses) == 1
    assert responses[0]["ok"] is True
    assert responses[0]["payload"]["hasError"] is False
