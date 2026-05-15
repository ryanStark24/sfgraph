# Sample agent conversations

Worked examples of how the installed skill playbooks route LLM intent into sfgraph tools.

## Before merging a PR

```
User: I'm about to merge this PR. Anything I should worry about?

Agent: *invokes sf-impact-from-diff*
       → impact_from_git_diff(diff="…", depth=3)
       → test_gap_intelligence_from_git_diff(diff="…")

       Your diff touches 3 nodes. 9 dependents at 3 hops:
         • 4 covered by tests (green)
         • 5 at-risk (no IS_TEST_FOR):
             - LWC:opportunityTile
             - ApexMethod:BillingSvc.run(2)
             - ApexMethod:BillingSvc.dryRun(0)
             - Flow:Order_Status_Update
             - LWC:invoiceTile

       [Mermaid: changed=red, at_risk=yellow, covered=green]

       Recommend adding test coverage for BillingSvc.run(2) before merging.
```

## Picking an org for cross-org compare

```
User: What's different between sandbox and prod?

Agent: *invokes sf-cross-org-diff*
       → first checks: which orgs are authenticated via sf CLI?

       I see these orgs in your `sf` config:
         • my-prod (default)        last ingested 6 days ago
         • my-sandbox               last ingested 2 hours ago
         • integration-uat          NOT yet ingested

       Want to compare my-prod ↔ my-sandbox?
       [user: yes]

       → cross_org_diff(org_a='my-prod', org_b='my-sandbox', category='all')

       Differences:
         • Only in my-sandbox: 12 ApexClasses, 3 Flows, 2 CustomFields
         • Only in my-prod:    1 deprecated trigger
         • Changed (different hash): 7 nodes

       Note: my-prod ingest is 6 days old. Run `sfgraph ingest --org my-prod`
       for a fresher comparison.

       Tip: to refresh both at once, run
         `sfgraph ingest --orgs my-prod,my-sandbox --parallel`
       (or `sfgraph ingest --all --parallel` to refresh every authenticated org).
```

## Initial onboarding

```
User: I just installed sfgraph. Where do I start?

Agent: 1. Check the `sf` CLI is authenticated:
          `sf org list` — should show at least one org marked default.
       2. Run initial ingest (this is the slow step; ~2-6 min):
          `sfgraph ingest`
       3. Restart your IDE so the MCP server picks up the new tools.
       4. Ask me a question. Examples:
          - "Show me a schema overview of the Account object."
          - "Who reads Account.Status__c?"
          - "What's the cross-layer path from accountTile to the DB?"
```
