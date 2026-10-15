import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { defineConfig } from "vitest/config";

// Every mcp-server test runs against throwaway sfgraph dirs. Without this, a test
// that forgets to set SFGRAPH_DATA_DIR opens (and migrates) the user's real
// graphs under ~/Library/Application Support/sfgraph.
const root = mkdtempSync(path.join(tmpdir(), "sfg-mcp-server-test-"));

export default defineConfig({
  test: {
    // Windows CI runners are several times slower on the heavier store tests
    // (a 3,000-node diff timed out at 5 s). Headroom there only; elsewhere
    // keep the default so a real hang still fails fast.
    testTimeout: process.platform === "win32" ? 30_000 : 5_000,
    // Same headroom for beforeEach/afterEach: per-test fixture setup (fresh
    // SQLite graph + seed) passed the 10 s hook default on Windows.
    hookTimeout: process.platform === "win32" ? 30_000 : 10_000,
    // Windows: forks, not threads. The threads pool crashed the run with a native
    // access violation (0xC0000005) on 536d313: every test loads better-sqlite3 /
    // sqlite-vec, and vitest documents that native modules can segfault under
    // worker threads. ("Timeout calling onTaskUpdate" came from CI running
    // several packages' suites at once; CI now runs them one at a time there.)
    ...(process.platform === "win32" ? { pool: "forks" as const, maxWorkers: 1 } : {}),
    env: {
      SFGRAPH_DATA_DIR: path.join(root, "data"),
      SFGRAPH_CACHE_DIR: path.join(root, "cache"),
      SFGRAPH_CONFIG_DIR: path.join(root, "config"),
      SFGRAPH_LOG_DIR: path.join(root, "log"),
      SFGRAPH_TEMP_DIR: path.join(root, "temp"),
    },
  },
});
