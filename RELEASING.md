# Releasing sfgraph

This monorepo publishes seven packages to the `@ryanstark24` npm scope. The
publish path is automated and **guarded** because a 2026-05-17 mistake
shipped 1.2.0 of three packages with unresolved `workspace:*` deps,
breaking every install. Don't repeat that.

## TL;DR

```bash
# 1. Bump the versions of changed packages, update CHANGELOG.md
# 2. Commit + tag + push:
git tag -a v1.X.Y -m "release 1.X.Y" && git push origin master v1.X.Y
# 3. Preflight (catches the things that go wrong):
pnpm preflight:publish
# 4. Only if preflight returns 0:
pnpm release:publish
```

`pnpm release:publish` runs `pnpm preflight:publish` first and only
calls `pnpm -r publish` if every check passed. Never bypass it.

## The single most important rule

**ALWAYS use `pnpm publish`, never `npm publish`.**

This monorepo uses pnpm's `workspace:*` protocol to keep cross-package
deps in sync. `pnpm publish` rewrites `workspace:*` to a concrete
version at pack time. `npm publish` does not — it leaves the string
literal in the tarball and every install fails with
`EUNSUPPORTEDPROTOCOL`.

Defenses in depth:

1. **`prepublishOnly` hook** on every publishable package (`scripts/
   assert-pnpm-publish.mjs`) refuses to run if `$npm_config_user_agent`
   doesn't start with `pnpm/`. Catches `npm publish` at the exact
   moment it would have shipped broken bytes.

2. **Preflight script** (`scripts/preflight-publish.mjs`) packs every
   release-candidate via `pnpm pack` and grep-scans the resulting
   tarballs for any `workspace:` strings. If any leak through, it
   refuses to let you proceed.

3. **`pnpm release:publish` script** chains them: preflight first,
   `pnpm -r publish` second, and the second only runs if the first
   returned 0.

## What the preflight catches

Run `pnpm preflight:publish` and it tells you:

| Check | What goes wrong without it |
|---|---|
| 1. Publisher tool is pnpm | The `workspace:*` disaster. |
| 2. Packed tarballs have no `workspace:` strings | Same — defense in depth. |
| 3. Local version > registry version for everything we'd publish | Wasted publish call, 403 from npm, or worse, silent overwrite at same version. |
| 4. Internal cross-package deps resolve | Bumping `cli` while forgetting to bump `server` that `cli` depends on. |
| 5. CHANGELOG.md has an entry for each new version | Release with no notes is unauditable. |
| 6. `dist/` is newer than `src/` | Stale build artifacts ship broken code. |
| 7. Tests pass | Publishing broken code. |
| 8. Git working tree is clean on release-relevant paths | WIP not in git when a consumer pulls the tag. |
| 9. Git tag exists for the highest publish version | Untagged releases are unreachable in history. |

The script classifies every package as:

- **first-publish** — not yet on the registry; full validation applies
- **republish** — local version > registry version; full validation applies
- **skip** — local version unchanged from registry; reported but not checked

You only ever publish packages whose local version > registry. Bump
the version, then preflight.

## Typical release workflow

```bash
# Step 1 — bump versions for packages whose source changed in the release
$EDITOR packages/<pkg>/package.json   # bump "version"
$EDITOR CHANGELOG.md                  # add "## X.Y.Z" entry above the existing top entry

# Step 2 — rebuild dist (preflight check #6 will fail otherwise)
pnpm -r build

# Step 3 — verify tests still pass
pnpm -r test

# Step 4 — commit
git add -A
git commit -m "chore(release): X.Y.Z — <one-line summary>"

# Step 5 — tag the release
git tag -a vX.Y.Z -m "release X.Y.Z"

# Step 6 — push commit + tag together
git push origin master vX.Y.Z

# Step 7 — preflight (must return 0)
pnpm preflight:publish

# Step 8 — publish, only if preflight was green
pnpm release:publish
# or, if you want to bypass the preflight chain explicitly:
pnpm -r publish --access public --no-git-checks

# Step 9 — GitHub release
gh release create vX.Y.Z --title "vX.Y.Z — <summary>" --notes "$(awk '/^## X\.Y\.Z/,/^## /' CHANGELOG.md | sed '$d')"
```

## Handling a botched release

If you publish a broken version to npm:

1. **Bump every broken package** to the next patch (e.g. 1.2.0 broken
   → bump to 1.2.1 in source).
2. **Update CHANGELOG.md** with a release-notes section explaining
   the issue + the fix.
3. **Tag and push** the new version per the workflow above.
4. **Preflight + publish** the fixed versions.
5. **Deprecate the broken versions** so installs route to the fixed
   ones:
   ```bash
   npm deprecate '@ryanstark24/sfgraph-X@1.2.0' 'BROKEN — use 1.2.1+'
   ```

You **cannot** unpublish (npm forbids it after 24h, and within 24h it
breaks anyone who already pulled). Deprecate is the right tool.

## Per-package release cadence

Not every package needs to bump every release. Bump only the packages
whose source actually changed. The preflight catches the case where
you accidentally bump a package whose internal deps point at something
that doesn't exist on npm.

## Why we're paranoid about this

On 2026-05-17 we shipped sfgraph 1.2.0 — eighteen feature commits,
745 tests passing, a complete milestone. Three of the four published
tarballs were broken because `npm publish` left literal `workspace:*`
strings where concrete versions should have been. Every consumer who
ran `npm i -g @ryanstark24/sfgraph@1.2.0` saw `EUNSUPPORTEDPROTOCOL`
and the release looked dead on arrival.

The fix (1.2.1) was mechanical — pack via pnpm instead of npm — but
the lesson is that the build was already broken when we ran
`npm publish`; nobody noticed until users tried to install. The
preflight script makes that impossible to ship: if any tarball
contains `workspace:*`, preflight fails and the publish doesn't run.
