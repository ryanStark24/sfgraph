# sfgraph Test Kit

The pre-publish gate. **Tier 1 must be GO and Tier 2 spot-checks must pass before
`pnpm release:publish`.** Publishing is a pnpm workspace — always
`pnpm release:publish` / `pnpm publish`, **never `npm publish`** (npm ships literal
`workspace:*` deps and every install fails — this is the 1.2.0 incident).

Every shell: `export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"` first (the
`better-sqlite3` native binding must match the Homebrew node the tests run under;
a wrong-node ABI mismatch shows as `ERR_DLOPEN_FAILED`, not a code bug — fix with
`sfgraph doctor` → `node scripts/rebuild-bindings.mjs` if it appears).

---

## Tier 1 — local gate (no org required)

One command, fail-fast, prints GO / NO-GO:

```bash
pnpm test:kit            # full gate
pnpm test:kit --skip-tests   # skip the test stage (use sparingly)
```

Runs, in order: **lint → typecheck → build → test → preflight**. The preflight stage
(`scripts/preflight-publish.mjs`) is the release-artifact check that source tests can't
give you: it `pnpm pack`s every publish candidate and scans the tarball for `workspace:*`
leaks, stale `dist/`, missing changelog entries, an unclean tree, and a missing git tag.

**Pass criteria:** exit 0 / `GO`. Current baseline = **848 tests across 7 packages**, lint
clean, build clean, preflight green.

> Run Tier 1 from a **committed tree** — the preflight stage checks the working tree is
> clean on release-relevant paths (package.json, CHANGELOG) and that the version tag is
> pushed. A dirty tree is a correct NO-GO: you publish from a clean, tagged commit, not
> mid-edit.

---

## Tier 2 — org-connected validation (needs an authenticated Vlocity/OmniStudio org)

Tier 1 proves the code is internally correct and the artifact is shippable. Tier 2 proves
the fixes actually fire on a real org. Run on a machine where `sf org login web` has
authenticated an org that has Vlocity-CMT and/or OmniStudio installed (e.g.
`PLDT_DEV_Anshul`). Re-ingest with the built code first:

```bash
node apps/sfgraph/bin/sfgraph.mjs doctor          # binding loads, code-signing ok
node apps/sfgraph/bin/sfgraph.mjs ingest --org <alias> --rebuild 2>&1 | tee ingest.log
```

Then verify each fix landed. Each row is a GO/NO-GO spot-check:

| # | What to check | How | Expected |
|---|---|---|---|
| 1 | **No silent member drops** | grep `ingest.log` for the two count lines | `fan-out complete (N)` == `complete … members=N` |
| 2 | **Vlocity lineage exists** (routing + DRMapItem fix) | query the graph for `dr_reads_field` / `ip_calls_dr` / `os_uses_dr` edges, or run `sf-cross-layer-trace` on a DataRaptor | non-zero `DR_*`/`IP_*`/`OS_*` edges (was 0 pre-fix) |
| 3 | **Governor detects in-loop SOQL/DML** | `governor_risk_check` (MCP) or query `_sfgraph_governor_risks` | non-empty `soql_in_loop`/`dml_in_loop` rows on an org that has them (was 0) |
| 4 | **Traces are denoised** | `trace_upstream` on a class granted to many profiles | dependency edges shown; "N security/inferred edges hidden" note; not 100+ grant rows |
| 5 | **dead_code_audit is bounded** | `dead_code_audit` (MCP) | summary-by-confidence + capped list, not a multi-MB dump |
| 6 | **security_audit FLS is filtered** | `security_audit` (MCP) | gaps are real custom/standard fields; `+N CMDT/system hidden` note |
| 7 | **Semantic search works** | `find_similar` on a real node | relevant cross-type neighbours |
| 8 | **Skill routing** | ask the agent a dev/design/debug question | `sf-graph-router` selects a sensible skill; grounding-first observed |

**Pass criteria:** rows 1–7 as expected; row 8 is a judgment spot-check. Capture the
results (the capture-kit `HANDOVER_REPORT.md` format is a good template) and attach to the
release notes.

---

## Publish (only after Tier 1 GO + Tier 2 spot-checks pass)

```bash
pnpm release:publish      # re-runs preflight, then `pnpm -r publish --access public`
```

Never `npm publish`. If preflight blocks on a version/tag/changelog issue, fix that —
the block is the guard working, not an obstacle to bypass.
