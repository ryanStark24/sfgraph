import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { defineConfig } from "vitest/config";

// Every core test runs against throwaway sfgraph dirs. Without this, a test
// that forgets to set SFGRAPH_DATA_DIR opens (and migrates) the user's real
// graphs under ~/Library/Application Support/sfgraph.
const root = mkdtempSync(path.join(tmpdir(), "sfg-core-test-"));

export default defineConfig({
  test: {
    // GitHub's Windows runners run the timer-heavy extractor tests about 10x
    // slower than Linux (0.1-0.7 s there; past the 5 s default here, and a
    // different set each run). Give Windows headroom; elsewhere keep the
    // default so a real hang still fails fast.
    testTimeout: process.platform === "win32" ? 30_000 : 5_000,
    env: {
      SFGRAPH_DATA_DIR: path.join(root, "data"),
      SFGRAPH_CACHE_DIR: path.join(root, "cache"),
      SFGRAPH_CONFIG_DIR: path.join(root, "config"),
      SFGRAPH_LOG_DIR: path.join(root, "log"),
      SFGRAPH_TEMP_DIR: path.join(root, "temp"),
    },
  },
});
