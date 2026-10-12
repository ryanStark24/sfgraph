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
    env: {
      SFGRAPH_DATA_DIR: path.join(root, "data"),
      SFGRAPH_CACHE_DIR: path.join(root, "cache"),
      SFGRAPH_CONFIG_DIR: path.join(root, "config"),
      SFGRAPH_LOG_DIR: path.join(root, "log"),
      SFGRAPH_TEMP_DIR: path.join(root, "temp"),
    },
  },
});
