#!/usr/bin/env python3
"""Fail CI when benchmark/acceptance quality thresholds regress."""
from __future__ import annotations

import argparse
import json
from pathlib import Path


def _load_json(path: str) -> dict:
    payload = json.loads(Path(path).read_text(encoding="utf-8"))
    if not isinstance(payload, dict):
        raise ValueError(f"Expected JSON object at {path}")
    return payload


def main() -> int:
    parser = argparse.ArgumentParser(description="Validate sfgraph quality-gate artifacts.")
    parser.add_argument("--benchmark", required=True, help="Path to benchmark JSON output.")
    parser.add_argument("--acceptance", required=True, help="Path to acceptance JSON output.")
    parser.add_argument("--min-pass-rate", type=float, default=1.0)
    parser.add_argument("--max-avg-duration-ms", type=float, default=3000.0)
    args = parser.parse_args()

    benchmark = _load_json(args.benchmark)
    acceptance = _load_json(args.acceptance)

    failed: list[str] = []

    thresholds = benchmark.get("thresholds", {})
    if not isinstance(thresholds, dict):
        failed.append("Benchmark payload missing `thresholds` object.")
    else:
        for key, value in thresholds.items():
            if value is not True:
                failed.append(f"Benchmark threshold failed: {key}={value!r}")

    summary = acceptance.get("summary", {})
    if not isinstance(summary, dict):
        failed.append("Acceptance payload missing `summary` object.")
    else:
        pass_rate = float(summary.get("expectation_pass_rate") or 0.0)
        avg_duration_ms = float(summary.get("avg_duration_ms") or 0.0)
        if pass_rate < args.min_pass_rate:
            failed.append(
                f"Acceptance expectation_pass_rate {pass_rate:.3f} is below min {args.min_pass_rate:.3f}."
            )
        if avg_duration_ms > args.max_avg_duration_ms:
            failed.append(
                f"Acceptance avg_duration_ms {avg_duration_ms:.2f} exceeds max {args.max_avg_duration_ms:.2f}."
            )

    if failed:
        for msg in failed:
            print(f"[quality-gate] {msg}")
        return 1

    print("[quality-gate] PASS")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
