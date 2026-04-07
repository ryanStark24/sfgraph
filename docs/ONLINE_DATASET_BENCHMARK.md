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
