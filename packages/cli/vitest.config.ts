import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { defineConfig } from "vitest/config";

// Every cli test runs against throwaway sfgraph dirs. Without this, a test
// that forgets to set SFGRAPH_DATA_DIR opens (and migrates) the user's real
// graphs under ~/Library/Application Support/sfgraph.
const root = mkdtempSync(path.join(tmpdir(), "sfg-cli-test-"));

export default defineConfig({
  test: {
    // Same Windows headroom as core and mcp-server: the diagnose and --rebuild
    // integration tests (real SQLite files, ingest end to end) take 5-9 s on
    // GitHub's Windows runners, past the 5 s default. Elsewhere keep the
    // default so a real hang still fails fast.
    testTimeout: process.platform === "win32" ? 30_000 : 5_000,
    hookTimeout: process.platform === "win32" ? 30_000 : 10_000,
    // One worker on Windows, as in core and mcp-server: two overload the runner
    // ("Timeout calling onTaskUpdate" with every test passing).
    ...(process.platform === "win32" ? { maxWorkers: 1 } : {}),
    env: {
      SFGRAPH_DATA_DIR: path.join(root, "data"),
      SFGRAPH_CACHE_DIR: path.join(root, "cache"),
      SFGRAPH_CONFIG_DIR: path.join(root, "config"),
      SFGRAPH_LOG_DIR: path.join(root, "log"),
      SFGRAPH_TEMP_DIR: path.join(root, "temp"),
    },
  },
});
