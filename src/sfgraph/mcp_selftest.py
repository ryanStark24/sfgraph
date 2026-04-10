"""MCP/daemon-level self-test and performance benchmark runner."""
from __future__ import annotations

import json
import re
import statistics
import subprocess
import time
from pathlib import Path
from typing import Any

from sfgraph.daemon_client import ensure_daemon_client


TERMINAL_JOB_STATES = {"completed", "failed", "cancelled", "daemon_restarted"}


def _load_suite(path: Path) -> list[dict[str, Any]]:
    raw = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(raw, list):
        raise ValueError(f"Suite file must be a JSON array: {path}")
    out: list[dict[str, Any]] = []
    for idx, item in enumerate(raw, start=1):
        if not isinstance(item, dict):
            continue
        question = str(item.get("question", "")).strip()
        if not question:
            continue
        out.append(
            {
                "id": str(item.get("id") or f"q{idx}"),
                "question": question,
                "expected_mode": str(item.get("expected_mode")) if item.get("expected_mode") is not None else None,
                "mode": item.get("mode"),
                "strict": bool(item.get("strict", True)),
                "max_results": int(item.get("max_results", 30)),
            }
        )
    if not out:
        raise ValueError(f"Suite has no runnable entries: {path}")
    return out


def _median(values: list[float]) -> float:
    return float(statistics.median(values)) if values else 0.0


def _p95(values: list[float]) -> float:
    if not values:
        return 0.0
    if len(values) < 20:
        return float(max(values))
    return float(statistics.quantiles(values, n=20)[18])


def _extract_token(question: str) -> str | None:
    field_match = re.search(r"\b([A-Za-z][A-Za-z0-9_]*__c)\b", question)
    if field_match:
        return field_match.group(1)
    camel_match = re.search(r"\b([a-z][A-Za-z0-9_]{2,})\b", question)
    if camel_match:
        return camel_match.group(1)
    return None


def _native_search(repo_root: Path, token: str) -> tuple[int, float]:
    started = time.perf_counter()
    proc = subprocess.run(
        ["rg", "-n", token, str(repo_root)],
        capture_output=True,
        text=True,
        check=False,
    )
    elapsed_ms = (time.perf_counter() - started) * 1000.0
    if proc.returncode not in (0, 1):
        raise RuntimeError(proc.stderr.strip() or f"rg failed with code {proc.returncode}")
    hits = 0 if proc.returncode == 1 else sum(1 for line in proc.stdout.splitlines() if line.strip())
    return hits, elapsed_ms


def run_mcp_selftest(
    *,
    export_dir: str,
    data_dir: str,
    suite_path: str,
    include_globs: list[str] | None = None,
    exclude_globs: list[str] | None = None,
    mode: str = "graph_only",
    poll_interval_seconds: float = 0.5,
    timeout_seconds: float = 3600.0,
) -> dict[str, Any]:
    export_path = Path(export_dir).expanduser().resolve()
    data_path = Path(data_dir).expanduser().resolve()
    suite_file = Path(suite_path).expanduser().resolve()
    cases = _load_suite(suite_file)

    client = ensure_daemon_client(data_path, workspace_root=export_path)
    tool_calls = 0
    call_latencies_ms: list[float] = []
    ingest_poll_latencies_ms: list[float] = []

    def rpc(method: str, **params: Any) -> dict[str, Any]:
        nonlocal tool_calls
        started = time.perf_counter()
        result = client.call(method, **params)
        elapsed_ms = (time.perf_counter() - started) * 1000.0
        call_latencies_ms.append(elapsed_ms)
        tool_calls += 1
        return result

    started_ingest = time.perf_counter()
    start_payload = rpc(
        "start_ingest_job",
        export_dir=str(export_path),
        mode=mode,
        include_globs=include_globs or [],
        exclude_globs=exclude_globs or [],
    )
    job_id = str(start_payload.get("job_id"))
    if not job_id:
        raise RuntimeError(f"Invalid start_ingest_job response: {start_payload}")

    terminal_job: dict[str, Any] | None = None
    deadline = time.time() + timeout_seconds
    while time.time() <= deadline:
        poll_started = time.perf_counter()
        job = rpc("get_ingest_job", job_id=job_id)
        ingest_poll_latencies_ms.append((time.perf_counter() - poll_started) * 1000.0)
        state = str(job.get("state", "unknown")).lower()
        if state in TERMINAL_JOB_STATES:
            terminal_job = job
            break
        time.sleep(max(0.05, poll_interval_seconds))

    if terminal_job is None:
        raise TimeoutError(f"Timed out waiting for ingest job {job_id}")

    ingest_seconds = time.perf_counter() - started_ingest
    ingest_state = str(terminal_job.get("state", "unknown")).lower()

    analyze_results: list[dict[str, Any]] = []
    analyze_latencies_ms: list[float] = []
    native_latencies_ms: list[float] = []
    expected_checks = 0
    expected_passed = 0

    for case in cases:
        started = time.perf_counter()
        payload = rpc(
            "analyze",
            question=case["question"],
            mode=case.get("mode") or "auto",
            strict=bool(case.get("strict", True)),
            max_results=int(case.get("max_results", 30)),
            max_hops=4,
        )
        analyze_ms = (time.perf_counter() - started) * 1000.0
        analyze_latencies_ms.append(analyze_ms)

        actual_mode = str(payload.get("mode") or payload.get("routed_to") or "unknown")
        expected_mode = case.get("expected_mode")
        mode_pass = None
        if expected_mode is not None:
            expected_checks += 1
            mode_pass = actual_mode == expected_mode
            if mode_pass:
                expected_passed += 1

        token = _extract_token(case["question"])
        native_hits = None
        native_ms = None
        if token:
            try:
                hits, elapsed = _native_search(export_path, token)
                native_hits = hits
                native_ms = elapsed
                native_latencies_ms.append(elapsed)
            except Exception:
                native_hits = None
                native_ms = None

        analyze_results.append(
            {
                "id": case["id"],
                "question": case["question"],
                "expected_mode": expected_mode,
                "actual_mode": actual_mode,
                "mode_match": mode_pass,
                "latency_ms": round(analyze_ms, 2),
                "result_count": len(payload.get("findings", [])) if isinstance(payload.get("findings"), list) else None,
                "native_token": token,
                "native_hits": native_hits,
                "native_search_ms": round(native_ms, 2) if native_ms is not None else None,
            }
        )

    return {
        "meta": {
            "export_dir": str(export_path),
            "data_dir": str(data_path),
            "suite_path": str(suite_file),
            "job_id": job_id,
            "ingest_mode": mode,
        },
        "ingest": {
            "state": ingest_state,
            "elapsed_seconds": round(ingest_seconds, 3),
            "summary": terminal_job.get("summary"),
            "parser_stats": terminal_job.get("summary", {}).get("parser_stats")
            if isinstance(terminal_job.get("summary"), dict)
            else None,
        },
        "latency": {
            "tool_call_count": tool_calls,
            "all_rpc_median_ms": round(_median(call_latencies_ms), 2),
            "all_rpc_p95_ms": round(_p95(call_latencies_ms), 2),
            "ingest_poll_median_ms": round(_median(ingest_poll_latencies_ms), 2),
            "ingest_poll_p95_ms": round(_p95(ingest_poll_latencies_ms), 2),
            "analyze_median_ms": round(_median(analyze_latencies_ms), 2),
            "analyze_p95_ms": round(_p95(analyze_latencies_ms), 2),
            "native_search_median_ms": round(_median(native_latencies_ms), 2) if native_latencies_ms else None,
        },
        "quality": {
            "total_cases": len(analyze_results),
            "expected_mode_checks": expected_checks,
            "expected_mode_passed": expected_passed,
            "expected_mode_pass_rate": round(expected_passed / expected_checks, 3) if expected_checks else None,
        },
        "cases": analyze_results,
    }
