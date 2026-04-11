# Online Dataset Benchmark (Apex + Vlocity)

Use this to run an end-to-end dry run on public repositories that include both Salesforce Apex and Vlocity/Omni assets.

## Recommended public datasets

1. `https://github.com/pradhanTejeshwar/OmnistudioComponents`
2. `https://github.com/Soforce/vlocity-ex`
3. `https://github.com/SFDC-Assets/omnistudio-demo`

## Run the online quality suite

```bash
SFGRAPH_ONLINE_DATASET_TESTS=1 \
SFGRAPH_ONLINE_REPO_URL=https://github.com/pradhanTejeshwar/OmnistudioComponents.git \
uv run pytest tests/test_online_dataset_quality.py -m online_dataset -q
```

## Notes

- The suite runs `sfgraph ingest --mode graph_only` then `sfgraph acceptance`.
- Default dataset URL is `pradhanTejeshwar/OmnistudioComponents`.
- For very large repos (for example `OmnistudioComponents`), expect longer ingest time.

## Compare sfgraph vs native code search (local quality check)

After ingest, run:

```bash
uv run python bin/compare_sfgraph_vs_native.py \
  --repo-root /absolute/path/to/cloned/repo \
  --data-dir /absolute/path/to/data-dir
```

This checks that sfgraph returns exact evidence for representative questions where native lexical search has concrete hits.

## MCP/Daemon self-test (real tool-call path)

Run the end-to-end benchmark through the daemon tool surface (the same path MCP tools use):

```bash
uv run sfgraph selftest /absolute/path/to/cloned/repo \
  --data-dir /absolute/path/to/data-dir \
  --suite docs/acceptance_quality_gate_suite.json \
  --mode graph_only \
  --report-md /absolute/path/to/selftest-report.md
```

What this reports:

- ingest completion state and parser stats
- RPC latency (`median`/`p95`) across all tool calls
- `analyze` latency per case
- expected mode pass-rate from the suite
- estimated token/cost metrics by route
- evidence quality scoring and semantic fallback frequency
- native `rg` token lookup timings for quick side-by-side checks

For broader query coverage, run:

```bash
uv run sfgraph selftest /absolute/path/to/cloned/repo \
  --data-dir /absolute/path/to/data-dir \
  --suite docs/acceptance_question_suite_expanded.json \
  --mode graph_only \
  --report-md /absolute/path/to/selftest-expanded-report.md
```
