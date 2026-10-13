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
    // Windows: vitest's worker->main reporting kept timing out ("Timeout
    // calling onTaskUpdate", 60 s) with every test passing. No test blocks
    // that long and output is small, so it is the forks pool's child-process
    // IPC over Windows pipes; worker threads avoid it. The suite passes under
    // threads (verified on Linux). Fewer workers for the small runner too.
    ...(process.platform === "win32" ? { pool: "threads" as const, maxWorkers: 2 } : {}),
    env: {
      SFGRAPH_DATA_DIR: path.join(root, "data"),
      SFGRAPH_CACHE_DIR: path.join(root, "cache"),
      SFGRAPH_CONFIG_DIR: path.join(root, "config"),
      SFGRAPH_LOG_DIR: path.join(root, "log"),
      SFGRAPH_TEMP_DIR: path.join(root, "temp"),
    },
  },
});
