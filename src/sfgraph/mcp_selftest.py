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


def _mean(values: list[float]) -> float:
    if not values:
        return 0.0
    return float(sum(values) / len(values))


def _extract_token(question: str) -> str | None:
    field_match = re.search(r"\b([A-Za-z][A-Za-z0-9_]*__c)\b", question)
    if field_match:
        return field_match.group(1)
    camel_match = re.search(r"\b([a-z][A-Za-z0-9_]{2,})\b", question)
    if camel_match:
        return camel_match.group(1)
    return None


def _normalize_actual_mode(payload: dict[str, Any]) -> str:
    routed = str(payload.get("routed_to") or "").strip()
    if routed == "query":
        result_mode = payload.get("result", {}).get("mode") if isinstance(payload.get("result"), dict) else None
        if isinstance(result_mode, str) and result_mode:
            return result_mode
        return "query"
    if routed == "analyze_field":
        result_payload = payload.get("result")
        if isinstance(result_payload, dict):
            focus = str(result_payload.get("focus") or "").strip().lower()
            if focus == "writes":
                return "field_writes"
            if focus == "reads":
                return "field_reads"
            if focus == "explain":
                return "field_explain"
        return "analyze_field"
    if routed:
        return routed
    fallback = payload.get("mode")
    return str(fallback) if fallback is not None else "unknown"


def _estimate_tokens_from_text(text: str) -> int:
    # Lightweight approximation for benchmark trend tracking (not billing-accurate).
    return max(1, int(round(len(text) / 4.0)))


def _score_evidence_quality(payload: dict[str, Any]) -> float:
    evidence = payload.get("evidence")
    if not isinstance(evidence, list) or not evidence:
        return 0.0
    score = 0.0
    has_file_line = any(isinstance(item, dict) and item.get("file") and item.get("line") for item in evidence)
    if has_file_line:
        score += 0.4
    if len(evidence) >= 3:
        score += 0.2
    max_confidence = 0.0
    sources: set[str] = set()
    for item in evidence:
        if not isinstance(item, dict):
            continue
        sources.add(str(item.get("source", "")))
        try:
            max_confidence = max(max_confidence, float(item.get("confidence", 0.0)))
        except Exception:
            continue
    if max_confidence >= 0.9:
        score += 0.2
    if "exact" in sources and "graph" in sources:
        score += 0.2
    return round(min(1.0, score), 3)


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
    route_counts: dict[str, int] = {}
    semantic_fallback_count = 0
    low_confidence_count = 0
    evidence_quality_scores: list[float] = []
    estimated_prompt_tokens_total = 0
    estimated_response_tokens_total = 0
    route_latency_ms: dict[str, list[float]] = {}
    route_prompt_tokens: dict[str, list[int]] = {}
    route_response_tokens: dict[str, list[int]] = {}

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

        actual_mode = _normalize_actual_mode(payload)
        route_counts[actual_mode] = route_counts.get(actual_mode, 0) + 1
        fallback_payload = payload.get("fallback") if isinstance(payload.get("fallback"), dict) else {}
        semantic_invoked = bool(fallback_payload.get("semantic_invoked"))
        fallback_reason = fallback_payload.get("reason")
        if semantic_invoked:
            semantic_fallback_count += 1
        gate_payload = payload.get("confidence_gate") if isinstance(payload.get("confidence_gate"), dict) else {}
        has_material_evidence = gate_payload.get("has_material_evidence")
        if has_material_evidence is None:
            evidence = payload.get("evidence")
            has_material_evidence = bool(evidence) if isinstance(evidence, list) else None
        if has_material_evidence is False:
            low_confidence_count += 1
        evidence_quality_score = _score_evidence_quality(payload)
        evidence_quality_scores.append(evidence_quality_score)
        prompt_tokens_est = _estimate_tokens_from_text(case["question"])
        response_tokens_est = _estimate_tokens_from_text(json.dumps(payload, ensure_ascii=False, default=str))
        estimated_prompt_tokens_total += prompt_tokens_est
        estimated_response_tokens_total += response_tokens_est
        route_latency_ms.setdefault(actual_mode, []).append(analyze_ms)
        route_prompt_tokens.setdefault(actual_mode, []).append(prompt_tokens_est)
        route_response_tokens.setdefault(actual_mode, []).append(response_tokens_est)
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
                "semantic_fallback": semantic_invoked,
                "fallback_reason": fallback_reason,
                "has_material_evidence": has_material_evidence,
                "evidence_quality_score": evidence_quality_score,
                "prompt_tokens_est": prompt_tokens_est,
                "response_tokens_est": response_tokens_est,
                "total_tokens_est": prompt_tokens_est + response_tokens_est,
                "native_token": token,
                "native_hits": native_hits,
                "native_search_ms": round(native_ms, 2) if native_ms is not None else None,
            }
        )

    by_route: dict[str, dict[str, float | int]] = {}
    for route, latencies in route_latency_ms.items():
        prompt_list = route_prompt_tokens.get(route, [])
        response_list = route_response_tokens.get(route, [])
        by_route[route] = {
            "count": len(latencies),
            "latency_median_ms": round(_median(latencies), 2),
            "latency_p95_ms": round(_p95(latencies), 2),
            "prompt_tokens_est_total": int(sum(prompt_list)),
            "response_tokens_est_total": int(sum(response_list)),
            "total_tokens_est_total": int(sum(prompt_list) + sum(response_list)),
        }

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
            "semantic_fallback_count": semantic_fallback_count,
            "low_confidence_count": low_confidence_count,
            "avg_evidence_quality_score": round(_mean(evidence_quality_scores), 3) if evidence_quality_scores else 0.0,
            "route_counts": route_counts,
        },
        "cost": {
            "prompt_tokens_est_total": estimated_prompt_tokens_total,
            "response_tokens_est_total": estimated_response_tokens_total,
            "total_tokens_est_total": estimated_prompt_tokens_total + estimated_response_tokens_total,
            "avg_tokens_est_per_case": round(
                (estimated_prompt_tokens_total + estimated_response_tokens_total) / len(analyze_results), 2
            )
            if analyze_results
            else 0.0,
            "by_route": by_route,
        },
        "cases": analyze_results,
    }


def render_selftest_markdown(payload: dict[str, Any]) -> str:
    meta = payload.get("meta", {})
    ingest = payload.get("ingest", {})
    latency = payload.get("latency", {})
    quality = payload.get("quality", {})
    cost = payload.get("cost", {})
    cases = payload.get("cases", [])

    lines: list[str] = []
    lines.append("# SFGraph Selftest Report")
    lines.append("")
    lines.append("## Run Meta")
    lines.append(f"- export_dir: `{meta.get('export_dir')}`")
    lines.append(f"- data_dir: `{meta.get('data_dir')}`")
    lines.append(f"- suite: `{meta.get('suite_path')}`")
    lines.append(f"- job_id: `{meta.get('job_id')}`")
    lines.append(f"- ingest_mode: `{meta.get('ingest_mode')}`")
    lines.append("")
    lines.append("## Ingest")
    lines.append(f"- state: `{ingest.get('state')}`")
    lines.append(f"- elapsed_seconds: `{ingest.get('elapsed_seconds')}`")
    lines.append("")
    lines.append("## Quality")
    lines.append(f"- expected_mode_pass_rate: `{quality.get('expected_mode_pass_rate')}`")
    lines.append(f"- semantic_fallback_count: `{quality.get('semantic_fallback_count')}`")
    lines.append(f"- low_confidence_count: `{quality.get('low_confidence_count')}`")
    lines.append(f"- avg_evidence_quality_score: `{quality.get('avg_evidence_quality_score')}`")
    lines.append("")
    lines.append("## Latency")
    lines.append(f"- analyze_median_ms: `{latency.get('analyze_median_ms')}`")
    lines.append(f"- analyze_p95_ms: `{latency.get('analyze_p95_ms')}`")
    lines.append(f"- native_search_median_ms: `{latency.get('native_search_median_ms')}`")
    lines.append("")
    if isinstance(cost, dict) and cost:
        lines.append("## Cost (Estimated)")
        lines.append(f"- total_tokens_est_total: `{cost.get('total_tokens_est_total')}`")
        lines.append(f"- avg_tokens_est_per_case: `{cost.get('avg_tokens_est_per_case')}`")
        lines.append("")
    lines.append("## Cases")
    lines.append("| id | expected | actual | match | latency_ms | evidence_quality | semantic_fallback |")
    lines.append("| --- | --- | --- | --- | ---: | ---: | --- |")
    for case in cases if isinstance(cases, list) else []:
        if not isinstance(case, dict):
            continue
        lines.append(
            "| {id} | {expected} | {actual} | {match} | {latency} | {eq} | {sf} |".format(
                id=case.get("id"),
                expected=case.get("expected_mode"),
                actual=case.get("actual_mode"),
                match=case.get("mode_match"),
                latency=case.get("latency_ms"),
                eq=case.get("evidence_quality_score"),
                sf=case.get("semantic_fallback"),
            )
        )
    lines.append("")
    return "\n".join(lines)
