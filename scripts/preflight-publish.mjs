#!/usr/bin/env node
/**
 * Pre-publish validation. Run this from the repo root BEFORE invoking
 * `pnpm publish` for a release. Exits 0 if every check passes, non-zero
 * with a clear diagnosis if anything is wrong.
 *
 * What it checks (the disasters this script exists to prevent):
 *
 *  1. **Publisher tool is pnpm**. `npm publish` does not rewrite
 *     pnpm's `workspace:*` dep specifiers into concrete versions, so
 *     `npm publish` inside this monorepo silently ships broken
 *     tarballs to the registry. We hit this on 1.2.0 — published
 *     three packages with `workspace:*` in dependencies, every
 *     install failed with EUNSUPPORTEDPROTOCOL. Never again.
 *
 *  2. **Packed tarballs contain zero `workspace:` strings.** Defense
 *     in depth on #1: even if a future operator finds a creative way
 *     to invoke `npm publish` from inside a pnpm workspace, this scan
 *     catches the bad tarball before it leaves the machine.
 *
 *  3. **Every publish-candidate version is NEW on the registry.**
 *     npm rejects republishing at the same version (403 — we hit
 *     this too), and silently overwriting with a different tarball
 *     would be a supply-chain disaster. This check tells you up
 *     front which versions you need to bump.
 *
 *  4. **Internal cross-package deps resolve.** Every workspace-
 *     internal dep in a publish-candidate either points to a
 *     version that's already on npm OR to another package in the
 *     publish set. Catches the case where you bump A but forget B
 *     and A's deps point at a B version that no one published.
 *
 *  5. **CHANGELOG.md mentions every publish-candidate version.**
 *     A release without a changelog entry is a release that consumers
 *     can't reason about.
 *
 *  6. **`dist/` is fresh relative to `src/`.** Stale build artifacts
 *     ship broken bytecode. Cheap mtime check; if it fails, run
 *     `pnpm -r build` and re-preflight.
 *
 *  7. **Tests pass.** Releases must be green.
 *
 *  8. **Git working tree is clean** on tracked release-relevant
 *     paths (package.json files + CHANGELOG.md). Local-only files
 *     under .planning/ are ignored — they're not part of the
 *     release surface.
 *
 *  9. **Git tag exists for the highest publish-candidate version.**
 *     Releases without tags are unreachable in history.
 *
 * Usage:
 *
 *   node scripts/preflight-publish.mjs                # check all bumped packages
 *   node scripts/preflight-publish.mjs --filter cli   # narrow to one package name fragment
 *   node scripts/preflight-publish.mjs --skip-tests   # skip step 7 (use sparingly)
 *
 * Exit codes:
 *   0  every check passed; safe to `pnpm publish`
 *   1  one or more checks failed; do NOT publish until fixed
 *   2  script itself errored (bad invocation, missing deps, etc.)
 */

import { execSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// ---------------------------------------------------------------------------
// Tiny ANSI + log helpers
// ---------------------------------------------------------------------------
const RED = "\x1b[31m";
const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";
const CYAN = "\x1b[36m";
const DIM = "\x1b[2m";
const BOLD = "\x1b[1m";
const RESET = "\x1b[0m";

const failures = [];
const warnings = [];

function pass(check, detail = "") {
  process.stdout.write(`  ${GREEN}✓${RESET} ${check}`);
  if (detail) process.stdout.write(`  ${DIM}${detail}${RESET}`);
  process.stdout.write("\n");
}
function fail(check, detail) {
  failures.push({ check, detail });
  process.stdout.write(`  ${RED}✗${RESET} ${check}\n`);
  if (detail) {
    for (const line of detail.split("\n")) {
      process.stdout.write(`      ${RED}${line}${RESET}\n`);
    }
  }
}
function warn(check, detail) {
  warnings.push({ check, detail });
  process.stdout.write(`  ${YELLOW}!${RESET} ${check}\n`);
  if (detail) {
    for (const line of detail.split("\n")) {
      process.stdout.write(`      ${YELLOW}${line}${RESET}\n`);
    }
  }
}
function section(title) {
  process.stdout.write(`\n${BOLD}${CYAN}${title}${RESET}\n`);
}

// ---------------------------------------------------------------------------
// Arg parsing
// ---------------------------------------------------------------------------
const args = process.argv.slice(2);
const filterArg = (() => {
  const i = args.indexOf("--filter");
  return i >= 0 ? args[i + 1] ?? null : null;
})();
const skipTests = args.includes("--skip-tests");

function selected(pkg) {
  if (!filterArg) return true;
  return pkg.name.includes(filterArg);
}

// ---------------------------------------------------------------------------
// Discover publishable packages
// ---------------------------------------------------------------------------
function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function discoverPackages() {
  const dirs = [
    ...readdirSync(join(REPO_ROOT, "packages"), { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => join("packages", d.name)),
    ...readdirSync(join(REPO_ROOT, "apps"), { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => join("apps", d.name)),
  ];
  const out = [];
  for (const dir of dirs) {
    const pkgPath = join(REPO_ROOT, dir, "package.json");
    if (!existsSync(pkgPath)) continue;
    const json = readJson(pkgPath);
    if (json.private) continue; // skip non-publishable packages
    out.push({
      dir,
      absDir: join(REPO_ROOT, dir),
      name: json.name,
      version: json.version,
      pkgPath,
      json,
    });
  }
  return out;
}

/**
 * Classify each discovered package as `first-publish`, `republish`, or
 * `skip` based on local-vs-registry version comparison. Returns
 * `{ toPublish, toSkip }` so downstream checks only validate what's
 * actually being published.
 */
function classifyPackages(packages) {
  const toPublish = [];
  const toSkip = [];
  for (const pkg of packages) {
    let published = "";
    try {
      published = execSync(`npm view "${pkg.name}" version`, {
        stdio: ["ignore", "pipe", "pipe"],
      })
        .toString()
        .trim();
    } catch {
      // Package doesn't exist on registry yet — first publish.
      toPublish.push({ ...pkg, kind: "first-publish", published: null });
      continue;
    }
    const cmp = cmpSemver(pkg.version, published);
    if (cmp > 0) {
      toPublish.push({ ...pkg, kind: "republish", published });
    } else {
      toSkip.push({ ...pkg, published });
    }
  }
  return { toPublish, toSkip };
}

// ---------------------------------------------------------------------------
// Check 1: publisher is pnpm
// ---------------------------------------------------------------------------
function checkPublisherTool() {
  section("[1/9] Publisher tool");
  // This script can be invoked standalone (no user-agent set) — in that
  // case we just confirm pnpm is on PATH and warn if npm is being used.
  // The prepublishOnly hook in each package.json is the hard gate at
  // actual publish time.
  const ua = process.env.npm_config_user_agent ?? "";
  if (ua.includes("pnpm/")) {
    pass(`invoked under pnpm (${ua.split(" ")[0]})`);
    return;
  }
  if (ua.includes("npm/") && !ua.includes("pnpm/")) {
    fail(
      "invoked under npm — workspace:* deps will NOT be rewritten",
      `user-agent: ${ua}\nUse: pnpm publish ...   (not: npm publish)`,
    );
    return;
  }
  // No user-agent (running standalone via node). Make sure pnpm exists.
  try {
    const v = execSync("pnpm --version", { stdio: ["ignore", "pipe", "pipe"] })
      .toString()
      .trim();
    pass(`pnpm ${v} on PATH`, "(remember to use `pnpm publish`, not `npm publish`)");
  } catch {
    fail("pnpm is not on PATH — installs must use pnpm in this monorepo");
  }
}

// ---------------------------------------------------------------------------
// Check 2 + 4: pack each package, scan for workspace: strings + verify
// all internal deps resolve to a published or about-to-publish version
// ---------------------------------------------------------------------------
function checkPackedTarballs(toPublish, toSkip = []) {
  section("[2/9] Packed tarballs do not leak workspace:* + [4/9] internal deps resolve");
  const packDir = mkdtempSync(join(tmpdir(), "sfgraph-preflight-"));
  try {
    // The "candidate set" for dep resolution = packages about to publish
    // PLUS packages already on the registry (their npm version is what
    // an internal dep will resolve against).
    const candidateNames = new Set(toPublish.map((p) => p.name));
    const candidateVersions = new Map(toPublish.map((p) => [p.name, p.version]));

    for (const pkg of toPublish) {
      try {
        execSync(`pnpm pack --pack-destination "${packDir}"`, {
          cwd: pkg.absDir,
          stdio: ["ignore", "pipe", "pipe"],
        });
      } catch (e) {
        fail(`${pkg.name}: pnpm pack failed`, String(e?.message ?? e));
        continue;
      }
      const tarballName = `${pkg.name.replace("@", "").replace("/", "-")}-${pkg.version}.tgz`;
      const tarballPath = join(packDir, tarballName);
      if (!existsSync(tarballPath)) {
        fail(`${pkg.name}: expected tarball missing`, tarballPath);
        continue;
      }
      let packJson;
      try {
        const raw = execSync(`tar -xzOf "${tarballPath}" package/package.json`, {
          stdio: ["ignore", "pipe", "pipe"],
        }).toString();
        packJson = JSON.parse(raw);
      } catch (e) {
        fail(`${pkg.name}: cannot read package.json from tarball`, String(e?.message ?? e));
        continue;
      }
      const depFields = ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"];
      const leaked = [];
      const unresolved = [];
      for (const field of depFields) {
        const deps = packJson[field] ?? {};
        for (const [depName, spec] of Object.entries(deps)) {
          if (typeof spec !== "string") continue;
          if (spec.startsWith("workspace:")) {
            leaked.push(`${field}/${depName}: ${spec}`);
            continue;
          }
          // For internal deps, the spec must be a concrete version that
          // already exists on the registry OR is a package we're about
          // to publish in this same run.
          if (candidateNames.has(depName)) {
            const candidateVersion = candidateVersions.get(depName);
            if (spec === candidateVersion) continue; // about-to-publish — OK
            // The spec might be a range matching candidateVersion. We
            // accept exact match only for simplicity (pnpm pack always
            // emits exact for internal deps).
            unresolved.push(
              `${field}/${depName}: expected "${candidateVersion}" (in publish set), got "${spec}"`,
            );
          } else if (depName.startsWith("@ryanstark24/")) {
            // Internal dep but NOT in publish set — must already exist
            // on npm at the version pinned in the tarball.
            try {
              const published = execSync(`npm view "${depName}@${spec}" version`, {
                stdio: ["ignore", "pipe", "pipe"],
              })
                .toString()
                .trim();
              if (!published) {
                unresolved.push(
                  `${field}/${depName}: "${spec}" not on npm — bump ${depName} into this release`,
                );
              }
            } catch {
              unresolved.push(
                `${field}/${depName}: "${spec}" not on npm — bump ${depName} into this release`,
              );
            }
          }
        }
      }
      if (leaked.length === 0 && unresolved.length === 0) {
        pass(`${pkg.name}@${pkg.version}`, `tarball clean (${tarballName})`);
      } else {
        if (leaked.length > 0) {
          fail(
            `${pkg.name}@${pkg.version}: workspace:* leaked into tarball`,
            leaked.join("\n"),
          );
        }
        if (unresolved.length > 0) {
          fail(
            `${pkg.name}@${pkg.version}: internal dep version unresolved`,
            unresolved.join("\n"),
          );
        }
      }
    }
  } finally {
    try {
      rmSync(packDir, { recursive: true, force: true });
    } catch {
      /* ignore cleanup failure */
    }
  }
}

// ---------------------------------------------------------------------------
// Check 3: classification summary — every package needing publish is OK
// ---------------------------------------------------------------------------
function reportClassification(toPublish, toSkip) {
  section("[3/9] Classification: which packages need to publish");
  for (const pkg of toPublish) {
    if (pkg.kind === "first-publish") {
      pass(`${pkg.name}: ${pkg.version} (first publish — not yet on registry)`);
    } else {
      pass(`${pkg.name}: ${pkg.published} (npm) → ${pkg.version} (local) [republish]`);
    }
  }
  for (const pkg of toSkip) {
    process.stdout.write(
      `  ${DIM}—${RESET} ${pkg.name}@${pkg.version} ${DIM}(unchanged from npm — skip)${RESET}\n`,
    );
  }
  if (toPublish.length === 0) {
    warn("no packages need publishing — every local version matches npm");
  }
}

function cmpSemver(a, b) {
  const pa = a.split(/[.-]/).map((x) => Number.parseInt(x, 10) || 0);
  const pb = b.split(/[.-]/).map((x) => Number.parseInt(x, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i += 1) {
    const ai = pa[i] ?? 0;
    const bi = pb[i] ?? 0;
    if (ai > bi) return 1;
    if (ai < bi) return -1;
  }
  return 0;
}

// ---------------------------------------------------------------------------
// Check 5: CHANGELOG mentions every publish-candidate version
// ---------------------------------------------------------------------------
function checkChangelog(packages) {
  section("[5/9] CHANGELOG.md mentions every publish-candidate version");
  const changelogPath = join(REPO_ROOT, "CHANGELOG.md");
  if (!existsSync(changelogPath)) {
    fail("CHANGELOG.md not found at repo root");
    return;
  }
  const text = readFileSync(changelogPath, "utf8");
  // Group packages by version so we can de-dup the message
  const byVersion = new Map();
  for (const pkg of packages) {
    const arr = byVersion.get(pkg.version) ?? [];
    arr.push(pkg.name);
    byVersion.set(pkg.version, arr);
  }
  for (const [version, names] of byVersion) {
    // Match `## 1.2.1` or `## 1.2.1 — anything` at start of line
    const re = new RegExp(`^## ${version.replace(/\./g, "\\.")}( |$|\\b)`, "m");
    if (re.test(text)) {
      pass(`${version} (${names.join(", ")})`);
    } else {
      fail(
        `CHANGELOG.md has no "## ${version}" heading`,
        `Add a release-notes section for ${version} covering ${names.join(", ")}`,
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Check 6: dist/ fresh relative to src/
// ---------------------------------------------------------------------------
function checkDistFreshness(packages) {
  section("[6/9] dist/ is newer than src/ (build artifacts are fresh)");
  for (const pkg of packages) {
    const srcDir = join(pkg.absDir, "src");
    const distDir = join(pkg.absDir, "dist");
    if (!existsSync(srcDir)) {
      pass(`${pkg.name}: no src/ — skipping (likely a meta package)`);
      continue;
    }
    if (!existsSync(distDir)) {
      fail(`${pkg.name}: dist/ missing — run \`pnpm -r build\``);
      continue;
    }
    const newest = (dir) => {
      let mtime = 0;
      const stack = [dir];
      while (stack.length > 0) {
        const cur = stack.pop();
        if (!cur) break;
        let entries = [];
        try {
          entries = readdirSync(cur, { withFileTypes: true });
        } catch {
          continue;
        }
        for (const e of entries) {
          const p = join(cur, e.name);
          if (e.isDirectory()) {
            if (e.name === "__tests__" || e.name === "node_modules") continue;
            stack.push(p);
          } else {
            try {
              const st = statSync(p);
              if (st.mtimeMs > mtime) mtime = st.mtimeMs;
            } catch {
              /* ignore */
            }
          }
        }
      }
      return mtime;
    };
    const srcMtime = newest(srcDir);
    const distMtime = newest(distDir);
    if (distMtime >= srcMtime) {
      pass(`${pkg.name}: dist newer than src`);
    } else {
      const lagMs = srcMtime - distMtime;
      const lagSec = Math.round(lagMs / 1000);
      fail(
        `${pkg.name}: dist older than src by ${lagSec}s — run \`pnpm -r build\``,
        `newest src mtime: ${new Date(srcMtime).toISOString()}\nnewest dist mtime: ${new Date(distMtime).toISOString()}`,
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Check 7: tests pass
// ---------------------------------------------------------------------------
function checkTests() {
  section("[7/9] All tests pass");
  if (skipTests) {
    warn("--skip-tests passed — tests NOT run", "Use sparingly; re-publishing broken code is hard to undo");
    return;
  }
  try {
    execSync("pnpm -r test", {
      cwd: REPO_ROOT,
      stdio: ["ignore", "pipe", "pipe"],
    });
    pass("pnpm -r test (full monorepo suite green)");
  } catch (e) {
    fail("test suite failed", "Run `pnpm -r test` directly and fix before publishing");
  }
}

// ---------------------------------------------------------------------------
// Check 8: clean working tree on release-relevant paths
// ---------------------------------------------------------------------------
function checkGitClean() {
  section("[8/9] Git working tree is clean on release-relevant paths");
  try {
    const out = execSync("git status --porcelain", {
      cwd: REPO_ROOT,
      stdio: ["ignore", "pipe", "pipe"],
    })
      .toString()
      .trim();
    if (!out) {
      pass("git status clean across the entire tree");
      return;
    }
    const lines = out.split("\n");
    const releaseRelevant = lines.filter((l) => {
      const path = l.slice(3);
      if (path.startsWith(".planning/")) return false; // workflow-local
      if (path.includes("package.json")) return true;
      if (path === "CHANGELOG.md") return true;
      if (path.startsWith("scripts/")) return true;
      if (path.endsWith("README.md")) return true;
      if (path.startsWith("docs/")) return true;
      return false; // every other path is irrelevant to release surface
    });
    if (releaseRelevant.length === 0) {
      pass("no release-relevant paths modified (uncommitted changes in non-release files only)");
      const local = lines.length;
      if (local > 0) {
        warn(`${local} non-release path(s) uncommitted — won't block publish but worth knowing`, lines.join("\n"));
      }
    } else {
      fail(
        "uncommitted changes to release-relevant paths",
        releaseRelevant.join("\n") + "\nCommit (or stash) these before publishing",
      );
    }
  } catch (e) {
    warn("could not run git status", String(e?.message ?? e));
  }
}

// ---------------------------------------------------------------------------
// Check 9: git tag exists for the highest publish version
// ---------------------------------------------------------------------------
function checkGitTag(packages) {
  section("[9/9] Git tag exists for the highest publish-candidate version");
  const versions = [...new Set(packages.map((p) => p.version))];
  versions.sort(cmpSemver);
  const highest = versions[versions.length - 1];
  if (!highest) {
    warn("no candidate versions found — nothing to check");
    return;
  }
  const tagName = `v${highest}`;
  try {
    const out = execSync(`git tag --list ${tagName}`, {
      cwd: REPO_ROOT,
      stdio: ["ignore", "pipe", "pipe"],
    })
      .toString()
      .trim();
    if (out === tagName) {
      pass(`${tagName} exists locally`);
      // Also verify it's been pushed.
      try {
        const remote = execSync(`git ls-remote --tags origin ${tagName}`, {
          cwd: REPO_ROOT,
          stdio: ["ignore", "pipe", "pipe"],
        })
          .toString()
          .trim();
        if (remote) {
          pass(`${tagName} pushed to origin`);
        } else {
          warn(`${tagName} not pushed to origin`, `Run: git push origin ${tagName}`);
        }
      } catch {
        warn(`could not check origin for ${tagName} — proceed carefully`);
      }
    } else {
      fail(
        `tag ${tagName} does not exist`,
        `Create it: git tag -a ${tagName} -m "release ${highest}"\nThen: git push origin ${tagName}`,
      );
    }
  } catch (e) {
    warn("could not run git tag --list", String(e?.message ?? e));
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
function main() {
  process.stdout.write(`${BOLD}sfgraph preflight publish check${RESET}\n`);
  process.stdout.write(`${DIM}repo: ${REPO_ROOT}${RESET}\n`);
  if (filterArg) process.stdout.write(`${DIM}filter: ${filterArg}${RESET}\n`);

  const allPackages = discoverPackages();
  const packages = allPackages.filter(selected);
  if (packages.length === 0) {
    process.stdout.write(`${RED}no publishable packages found (filter: ${filterArg ?? "<none>"})${RESET}\n`);
    process.exit(2);
  }

  section("Candidate packages");
  for (const p of packages) {
    process.stdout.write(`  ${DIM}${relative(REPO_ROOT, p.absDir)}${RESET}  ${p.name}@${p.version}\n`);
  }

  const { toPublish, toSkip } = classifyPackages(packages);

  checkPublisherTool();
  // Steps 2/4/5/6/9 only need to validate packages we're actually publishing.
  // Skipped packages still need pnpm pack to confirm "if we DID publish, it
  // would be clean" — but we don't fail on them; treat as advisory.
  checkPackedTarballs(toPublish, toSkip);
  reportClassification(toPublish, toSkip);
  checkChangelog(toPublish);
  checkDistFreshness(toPublish);
  checkTests();
  checkGitClean();
  checkGitTag(toPublish);

  process.stdout.write(`\n${BOLD}summary${RESET}\n`);
  if (failures.length === 0) {
    process.stdout.write(
      `  ${GREEN}✓ all checks passed${RESET}${warnings.length > 0 ? ` (${warnings.length} warning${warnings.length === 1 ? "" : "s"})` : ""}\n`,
    );
    process.stdout.write(`\n  next: pnpm -r publish --access public --no-git-checks\n\n`);
    process.exit(0);
  }
  process.stdout.write(
    `  ${RED}✗ ${failures.length} check${failures.length === 1 ? "" : "s"} failed${RESET}`,
  );
  if (warnings.length > 0) {
    process.stdout.write(` (${warnings.length} warning${warnings.length === 1 ? "" : "s"})`);
  }
  process.stdout.write(`\n\n  do NOT publish until every failure is fixed.\n\n`);
  process.exit(1);
}

try {
  main();
} catch (e) {
  process.stdout.write(`\n${RED}preflight script crashed:${RESET} ${e?.stack ?? e}\n`);
  process.exit(2);
}
