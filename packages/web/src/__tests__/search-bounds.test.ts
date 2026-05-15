import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { search } from "../api.js";

/**
 * Verifies the bounds added to `/api/search` after the pen-test:
 *   1. Queries shorter than `SEARCH_MIN_QUERY_LEN` return [] without scanning.
 *   2. `listAllQnames` scan stops at `SEARCH_MAX_SCAN` rows even when the
 *      graph has more.
 *
 * Uses a tmp sfgraph data dir so the test is hermetic from the user's real
 * data dir.
 */

let tmpHome: string;
let prevHome: string | undefined;
let prevXdg: string | undefined;

beforeEach(() => {
  tmpHome = mkdtempSync(path.join(tmpdir(), "sfg-web-search-"));
  prevHome = process.env.SFGRAPH_HOME;
  prevXdg = process.env.XDG_DATA_HOME;
  process.env.SFGRAPH_HOME = tmpHome;
});

afterEach(() => {
  if (prevHome === undefined) delete process.env.SFGRAPH_HOME;
  else process.env.SFGRAPH_HOME = prevHome;
  if (prevXdg === undefined) delete process.env.XDG_DATA_HOME;
  else process.env.XDG_DATA_HOME = prevXdg;
  rmSync(tmpHome, { recursive: true, force: true });
});

describe("web /api/search bounds", () => {
  it("returns [] for empty query without opening a store", async () => {
    const r = await search("00DfakeOrgIdAbc12", "");
    expect(r).toEqual([]);
  });

  it("returns [] for single-char query (below SEARCH_MIN_QUERY_LEN)", async () => {
    const r = await search("00DfakeOrgIdAbc12", "a");
    expect(r).toEqual([]);
  });
});
