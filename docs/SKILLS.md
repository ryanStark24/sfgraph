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
| `sf-flow-impact`               | Map a Flow's runtime to dependents.                        |
| `sf-governor-risk-fix`         | Find SOQL/DML in loops and propose remediation.            |
| `sf-omnistudio-migration-audit`| Audit Vlocity -> OmniStudio migrations.                    |
| `sf-security-audit`            | Sharing rules, FLS gaps, shadow access.                    |
| `sf-what-broke`                | Correlate a recent failure to the metadata that changed.   |

## How a skill is wired

Each skill directory contains:

```
skills/<name>/
  SKILL.md      # playbook (intent + steps + verifications)
  meta.json     # which tools it calls, max hops, etc.
```

`sfgraph install` reads the manifest and writes IDE-specific configuration
(`~/.cursor/skills/`, `~/.claude/skills/`, VS Code workspace settings).
