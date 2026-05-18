#!/usr/bin/env node
/**
 * prepublishOnly guard. Refuses to let `npm publish` run inside this
 * monorepo — `npm publish` does NOT rewrite pnpm's `workspace:*` dep
 * specifiers into concrete versions, so the published tarball would
 * leak `workspace:*` strings into the registry and every install would
 * fail with EUNSUPPORTEDPROTOCOL.
 *
 * Exit 0 only when invoked under pnpm. Exit 1 otherwise.
 *
 * Detection: pnpm sets `npm_config_user_agent` to a string starting
 * with `pnpm/<version>`. npm sets it to `npm/<version>`. Both are
 * present in env when the publish lifecycle runs.
 */

const ua = process.env.npm_config_user_agent ?? "";

if (ua.includes("pnpm/")) {
  process.exit(0);
}

const RED = "\x1b[31m";
const BOLD = "\x1b[1m";
const RESET = "\x1b[0m";
const YELLOW = "\x1b[33m";

process.stderr.write(
  `\n${RED}${BOLD}REFUSING TO PUBLISH:${RESET} this monorepo uses pnpm's \`workspace:*\` protocol.\n\n` +
    `  npm publish does NOT rewrite \`workspace:*\` deps into concrete\n` +
    `  versions, so the resulting tarball would ship to the registry with\n` +
    `  literal "workspace:*" strings — every install would fail with\n` +
    `  ${YELLOW}EUNSUPPORTEDPROTOCOL: Unsupported URL Type "workspace:"${RESET}.\n\n` +
    `  This happened on 1.2.0; we will not let it happen again.\n\n` +
    `  ${BOLD}Use pnpm publish instead:${RESET}\n` +
    `    pnpm publish --access public --no-git-checks\n` +
    `    pnpm -r publish --access public --no-git-checks   (whole monorepo, in topo order)\n\n` +
    `  Detected user-agent: ${ua || "(unset — likely a direct `npm publish` invocation)"}\n\n`,
);
process.exit(1);
