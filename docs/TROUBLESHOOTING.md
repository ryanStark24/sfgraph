# Troubleshooting

First step for any unexpected behavior:

```bash
sfgraph doctor
```

Every failed check prints a copy-paste fix command. The sections below explain the failure modes in more depth.

---

## `bindings file not found` / `NODE_MODULE_VERSION` / `Module did not self-register`

`better-sqlite3` ABI mismatch — the native binding was compiled against a different Node ABI than the one currently running. Common causes:

- You upgraded Node after installing sfgraph.
- You're on a brand-new Node release without prebuilts yet (e.g. the days right after a major Node release).
- An IDE (Cursor, VS Code, Claude Desktop) spawns the MCP server with its own bundled Node that differs from your shell's.

**Fix:**

```bash
sfgraph rebuild-bindings
```

Auto-detects npm vs pnpm, rebuilds the binding against the current Node, verifies it loads. Requires a C++ toolchain:

- **macOS**: `xcode-select --install`
- **Linux**:
  - Debian / Ubuntu: `apt install build-essential python3`
  - Fedora / RHEL / Rocky: `dnf groupinstall "Development Tools" && dnf install python3`
  - Arch / Manjaro: `pacman -S base-devel python`
  - Alpine: `apk add build-base python3` (also note: `better-sqlite3` prebuilts target glibc, so Alpine/musl users *always* hit the source compile — install once and you're set)
- **Windows**: install [Visual Studio Build Tools](https://visualstudio.microsoft.com/visual-cpp-build-tools/) with the **"Desktop development with C++"** workload, then restart your shell so `cl.exe` is on PATH. Alternatively, install Node via [`nvm-windows`](https://github.com/coreybutler/nvm-windows) and pick a Node major that already has a `better-sqlite3` prebuilt — skips the source-compile entirely.

If the rebuild works but the **IDE** still errors, the IDE's Node ABI differs from your shell's. Pin the IDE child to your shell's Node:

```bash
sfgraph install --local --pin-node "$(which node)"
```

---

## Silent ingest death on macOS (SIGKILL / Code Signature Invalid)

**Symptom.** `sfgraph ingest` runs for 30–60 seconds, prints progress normally, then the terminal returns to the prompt with no completion message, no error, and no entry in any application log.

**Cause.** macOS 26+ enforces native code-signing strictly. Node addons (`.node` files like `better_sqlite3.node`) ship with a "linker-signed adhoc" placeholder signature from the build toolchain. dyld rejects those on `dlopen()` and the kernel SIGKILLs the process — at kernel level, bypassing every JS-side handler.

**Detection.** `sfgraph doctor` flags it:

```
⚠ macOS code-signing: binding has linker-signed adhoc stamp;
  macOS 26+ may SIGKILL on dlopen. Re-sign with ad-hoc.
  fix: codesign --force --sign - "/path/to/better_sqlite3.node"
```

**Fix.** Re-sign with a fresh ad-hoc signature (the `-` after `--sign` is literal):

```bash
codesign --force --sign - "/path/to/better_sqlite3.node"

# Or re-sign every native addon under your install:
find $(npm root -g)/@ryanstark24/sfgraph -name '*.node' \
  -exec codesign --force --sign - {} \;
```

Starting in v1.0.x, sfgraph's postinstall automatically re-signs every `.node` file on macOS as part of `npm install`. If you installed an older version and only just hit this, re-install or run the manual `find … codesign` above once.

### If re-signing didn't help — AMFI / Hardened Runtime trap

**Symptom.** You re-signed, `sfgraph doctor` shows `macOS code-signing ✓`, but ingest still dies silently. The kernel log shows:

```
AMFI: '/path/to/better_sqlite3.node' is adhoc signed.
AMFI: code signature validation failed.
```

**Cause.** Your Node binary (typical for Node.js Foundation builds via nvm or the official `.pkg` installer) is signed with **Hardened Runtime + library validation enabled**. Library validation means Node refuses to `dlopen()` any dylib not signed by the same team that signed Node. Apple Foundation ≠ ad-hoc, so AMFI kills the process. `codesign --verify` on the binding still passes — the rejection is policy-level.

**Detection.** `sfgraph doctor` flags this case proactively:

```
⚠ macOS code-signing: Node has Hardened Runtime with library validation;
  AMFI will SIGKILL on ad-hoc-signed bindings mid-ingest (silent death,
  no error). Re-sign Node with disable-library-validation entitlement.
```

Confirm by running:

```bash
log stream --predicate 'eventMessage CONTAINS "AMFI"' --info
```

in a second terminal while the ingest runs.

**Fix.** Add the `com.apple.security.cs.disable-library-validation` entitlement to your Node binary. One-time operation per Node install:

```bash
cat > /tmp/node-libval.plist << 'EOF'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>com.apple.security.cs.disable-library-validation</key><true/>
  <key>com.apple.security.cs.allow-jit</key><true/>
  <key>com.apple.security.cs.allow-unsigned-executable-memory</key><true/>
</dict>
</plist>
EOF

codesign --force --sign - --entitlements /tmp/node-libval.plist "$(which node)"
```

After this, Node accepts ad-hoc-signed children. The entitlement only loosens *library validation*; the rest of Hardened Runtime stays intact.

**Why we don't do this in postinstall.** Modifying your global Node binary from a package's postinstall would be intrusive and irreversible without re-installing Node. The doctor surfaces the fix; you opt in by running the one-liner.

---

## `sfgraph ingest` hangs / appears wedged

Ingest emits a heartbeat every 10 seconds with the last-active source. If `processed` stops incrementing and no new source label appears, run with diagnostics:

```bash
SFGRAPH_DEBUG_POOLS=1 sfgraph ingest --org <alias> --debug
```

The heartbeat then includes per-pool counters (Tooling / Metadata / Data):

```
ingest: [pool meta] running=10 executing=10 queued=18 received=42 reservoir=0
```

Interpretation:

| Pattern | Likely cause |
|---|---|
| `running=cap` + `reservoir=0` for >60s | Reservoir starvation — bump `--metadata-pool` or wait for refresh. |
| `running=cap` + `reservoir>0`, counts frozen | Stuck-in-flight HTTP — Salesforce-side slowness, watchdog will trip at 5min. |
| `running<cap` + `queued=0` + no yields | Source iterator parked pre-yield — `--debug` will name the source. |
| Counts moving but yields gapped 60–120s | Working as designed but slow — bump pool sizes. |

A 90-second first-yield watchdog and a 5-minute inactivity watchdog kill genuinely-wedged sources automatically. If you don't see those fire, the run isn't actually wedged — it's slow.

Always check `sf org list` works first — auth issues are the most common cause of an apparent hang.

---

## MCP server shows no tools / agent ignores sfgraph

1. **Fully restart the IDE** — MCP clients cache the tool list until reconnect.
2. **Verify the config was written:**
   ```bash
   sfgraph install --target cursor --dry-run
   cat ~/.cursor/mcp.json
   ```
3. **Run `sfgraph doctor`** and confirm the `IDE MCP configs` row lists your IDE.

---

## `list_orgs` returns empty / "0 orgs"

Either the `sf` CLI can't auth from the MCP child process (Cursor often inherits a stripped `PATH`), or no orgs have been ingested yet.

```bash
sfgraph doctor      # check "sf CLI" and "org databases" rows
sf org list         # from the same shell
```

If `sf org list` works but `list_orgs` from the MCP client returns empty, the data-dir fallback kicked in but found nothing. Run:

```bash
sfgraph refresh-orgs        # snapshots sf-CLI state for sandboxed MCP children
sfgraph ingest --org <alias>
```

---

## Environment-variable reference

Every override sfgraph honors at runtime. Most of these have CLI-flag
equivalents (preferred); env vars are useful for IDE-spawned MCP
children and CI runs where you can't pass flags.

### Paths / install layout

| Variable | Default | What it does |
|---|---|---|
| `SFGRAPH_HOME` | `~/.sfgraph` | Override the root sfgraph dir. |
| `SFGRAPH_DATA_DIR` | platform-specific | Where per-org `<orgId>.sqlite` files live. |
| `SFGRAPH_CONFIG_DIR` | platform-specific | Where `sfgraph.json` + machine-id live. |
| `SFGRAPH_CACHE_DIR` | platform-specific | Embedding-model + transient cache. |
| `SFGRAPH_LOG_DIR` | platform-specific | sfgraph's own logs (separate from your shell stderr). |
| `SFGRAPH_TEMP_DIR` | OS tmpdir | Temp scratch (rebuild backups in flight, etc.). |
| `SFGRAPH_ALLOW_ANY_DB` | unset | When set, lets `--db` point outside the data dir. Off by default to prevent accidental cross-org overwrites. |

### Ingest tuning

| Variable | Default | What it does |
|---|---|---|
| `SFGRAPH_TOOLING_POOL` | `5` | Max concurrent Tooling-API calls. Same as `--tooling-pool`. |
| `SFGRAPH_METADATA_POOL` | `10` | Max concurrent Metadata-API calls. Same as `--metadata-pool`. |
| `SFGRAPH_DATA_POOL` | `10` | Max concurrent SObject/Bulk queries. Same as `--data-pool`. |
| `SFGRAPH_SOURCE_CONCURRENCY` | `12` | How many source extractors run in parallel in the sliding window. Lower if you're hitting too many concurrent connections; higher rarely helps. |
| `SFGRAPH_SEQUENTIAL_SOURCES` | unset | Legacy escape hatch — runs extractors strictly serially. Use only if parallel ingest is misbehaving in a way the pool knobs don't address. |
| `SFGRAPH_BISECT_MAX_DEPTH` | `6` | How deep `readMetadataBatchAdaptive` recurses when bisecting a failed batch. Lower bound = faster fail; higher bound = more salvage. |
| `SFGRAPH_AUTO_RETRY_THRESHOLD` | `10` | More than N transient skips triggers the post-ingest auto-retry. |
| `SFGRAPH_NO_AUTO_RETRY` | unset | Disable the auto-retry pass entirely. Same as `--no-auto-retry-skipped`. |
| `SFGRAPH_NO_LIVENESS_PROBE` | unset | Disable the conn.identity() liveness probe. Useful in tests with mock connections that don't implement `identity()`. |
| `SFGRAPH_SKIP_THRESHOLD` | (varies by pool) | Per-pool skip-trigger threshold for the resilience layer. Tune only after reading the pool source. |
| `SFGRAPH_DEBUG_INGEST` | unset | Verbose tracing + heartbeat + per-source phase logs. Same as `--debug`. |
| `SFGRAPH_DEBUG_POOLS` | unset | Adds per-pool `running/queued/reservoir` counters to the heartbeat. Strict subset of `SFGRAPH_DEBUG_INGEST=1`. |

### Coverage knobs (what to include / exclude)

| Variable | Default | What it does |
|---|---|---|
| `SFGRAPH_INCLUDE_MANAGED` | unset | Globally include managed-package source content. By default managed Apex / LWC ship as metadata-only stubs (faster + safer). |
| `SFGRAPH_INCLUDE_MANAGED_LWC` | unset | LWC-only override of the above. |
| `SFGRAPH_INCLUDE_SYSTEM_SOBJECTS` | unset | Include `ApexLog`, `EventLogFile`, etc. Almost never wanted. |
| `SFGRAPH_INCLUDE_ALL_SOBJECTS` | unset | Bypass the EntityDefinition gate; include every queryable SObject. |
| `SFGRAPH_INCLUDE_ALL_GENERIC` | unset | Bypass the generic-metadata whitelist; route every metadata type the org returns. |
| `SFGRAPH_SKIP_LWC` | unset | Comma-separated DeveloperNames of LWC bundles to skip (e.g. one that crashes describe). |
| `SFGRAPH_SKIP_SOBJECT` | unset | Comma-separated SObject names to skip. |

### Embedding model overrides

| Variable | Default | What it does |
|---|---|---|
| `SFGRAPH_EMBED_MODEL_PATH` | (vendored MiniLM) | Absolute path to a transformers.js-compatible model dir. |
| `SFGRAPH_EMBED_MODEL_ID` | `Xenova/all-MiniLM-L6-v2` | Model id under that dir. |
| `SFGRAPH_EMBED_MODEL_DIM` | `384` | Embedding dimension. Must match the model. |

### Parser internals

| Variable | Default | What it does |
|---|---|---|
| `SFGRAPH_APEX_PARSER` | (worker pool) | Override apex-parser strategy (e.g. force in-process). Internal — most users never need this. |

---

## Windows install issues

sfgraph runs on Windows 10/11 under Node ≥ 20. Install via `npm install -g @ryanstark24/sfgraph`; the `sfgraph install` command writes the MCP host config with `npx.cmd` (not `npx`) so Claude Code / Cursor on Windows invoke the right binary. Make sure Git LFS is installed before `npm install` so the vendored embedding model resolves on first ingest.
