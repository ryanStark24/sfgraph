# sfgraph Skills

Skills are SKILL.md playbooks bundled in `@ryanstark24/sfgraph-skills`. Each ships an
intent description, decision rubric, and a chain of MCP tool calls. After
`sfgraph install` they are written to the host IDE's skill directory.

| Skill                          | Intent                                                     |
| ------------------------------ | ---------------------------------------------------------- |
| `sf-impact-from-diff`          | Translate a git diff into a blast-radius report.           |
| `sf-cross-org-diff`            | Compare two orgs and explain the drift.                    |
| `sf-cross-layer-trace`         | LWC -> Apex -> SOQL -> Field path with Mermaid.            |
| `sf-dead-code-audit`           | Surface stale, orphaned metadata with confidence.          |
| `sf-deployment-manifest`       | Emit package.xml + destructiveChanges.xml between orgs.    |
| `sf-explain-code`              | Explain an Apex method or code unit and cache it back.     |
| `sf-flow-impact`               | Map a Flow's runtime to dependents.                        |
| `sf-governor-risk-fix`         | Find SOQL/DML in loops and propose remediation.            |
| `sf-metadata-refresh`          | Detect graph staleness and tell the user which `sfgraph ingest` command to run. |
| `sf-omnistudio-migration-audit`| Audit Vlocity -> OmniStudio migrations.                    |
| `sf-schema-overview`           | Summarise an org's object/field topology.                  |
| `sf-security-audit`            | Sharing rules, FLS gaps, shadow access.                    |
| `sf-snapshot-compare`          | Walk an operator through two-snapshot diffs.               |
| `sf-what-broke`                | Correlate a recent failure to the metadata that changed.   |
| `sf-wip-impact`                | Blast-radius for uncommitted working-tree changes.         |
| `sf-web-explorer`              | Launch the local web visualiser for visual graph exploration. |
| `sf-find-similar`              | Semantic neighbour search — find metadata similar to an existing node or a free-text concept via MiniLM-L6 embeddings. |

## How a skill is wired

Each skill directory contains:

```
skills/<name>/
  SKILL.md      # playbook (intent + steps + verifications)
```

`sfgraph install` reads the bundled SKILL.md files and writes IDE-specific configuration
(`~/.cursor/rules/` for Cursor, `~/.claude/skills/` for Claude Code, VS Code via the Claude extension).

See [`ARCHITECTURE.md`](ARCHITECTURE.md) for how skills compose tool calls into agent flows.
