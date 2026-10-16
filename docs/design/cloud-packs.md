# Design: cloud packs — plug-and-play support per Salesforce cloud

**Status:** proposed (design only — not yet implemented)
**Author:** 2026-10-13, during the 1.6.0 release review
**Scope:** let users choose which Salesforce clouds they use (core platform, Vlocity / Communications Cloud, OmniStudio on core, later others) so ingest runs only the relevant extractors, parsers and resolvers. A new cloud is added without editing core.

## Problem

sfgraph supports two clouds today: the core platform, and Vlocity / OmniStudio (legacy Communications Cloud and OmniStudio on core). More will follow, for example Financial Services Cloud or Health Cloud. The cloud-specific code is a modest share of `core`: about 30 files and ~3,800 LOC, roughly 10% of `packages/core/src`. The problem is how it is wired. Generic code branches on Vlocity at about 15 places, so every new cloud would add more `if (caps.x)` branches, switch cases and closed-enum entries across core. Each addition makes the others harder to change.

Goals:

1. **Selection.** A user (or auto-detection) picks the clouds. Ingest runs only what those clouds need.
2. **Horizontal growth.** A new cloud is a new package. It does not edit core files.
3. **No regressions.** Existing graphs keep the same nodes, edges and qualified names through the refactor.

Non-goals: loading third-party plugins dynamically from npm, and per-member cloud selection.

## Current surface (grounded in code)

There is no pack or plugin mechanism. The only open registry is the parser registry, and it is filled by side-effect imports.

| Choke point | Where | How Vlocity / OmniStudio is wired |
|---|---|---|
| Capability probe | `extractors/live-org/capabilities.ts` (`OrgCapabilities`, `VLOCITY_NAMESPACE_CANDIDATES`) | Probes `${ns}__DRBundle__c`, `OmniProcess` and others. Returns boolean flags: `vlocityLegacy`, `omnistudioOncore`, `agentforce`, … |
| Extractor fan-out | `extractors/live-org/bulk-retrieve.ts` (`if (caps.vlocityLegacy)` / `if (caps.omnistudioOncore)` around `invoke(...)`) | Hard-coded branches per source. Per-source timeouts are keyed by name. |
| Fetch routing | `extractors/live-org/dispatch.ts` (`FetchStrategy` `"vlocityRunner"`, `VLOCITY_DATAPACK_TYPES`) | Hard-coded strategy and type set. |
| Filesystem walk | `extractors/filesystem/index.ts` (`vlocity/datapacks`, `detectVlocityNamespace`) | Hard-coded directory. |
| Member → parser routing | `ingest/parse-member.ts` (`switch` on `OmniProcess`… and the `VLOCITY_MEMBER_TO_PARSER` map) | A switch and a map in generic code. |
| Parser registration | `parsers/index.ts` (`import "./vlocity/index.js"`, `import "./omnistudio/index.js"`) | Unconditional side-effect imports. |
| Hooks inside core parsers | `parsers/apex/vlocity-calls.ts` (called from `parsers/apex/class.ts`), `parsers/lwc/omnidef.ts` (from `parsers/lwc/bundle.ts`), the `LWC_CALLS_IP` edge in `parsers/lwc/js-visitor.ts` | Vlocity logic inside the core Apex and LWC parsers. |
| Post-merge passes | `ingest/live-ingest.ts` (`resolveCrossFlavor`, the OmniStudio overlap detector, `resolveVlocityApex`, the DR relationship resolver, `resolveVlocityNameMatches`; each has a `disable*` option) | A fixed sequence of try blocks. |
| Domain | `domain/rel-types.ts` (~22 Vlocity and OMNI_* edge types, `CANONICAL_OF`), `domain/metadata-category.ts` | Closed `const` objects. A new cloud edits core. |
| Analysis | `analyze/dead-code.ts` (compiled-OmniScript liveness), `analyze/component-scope.ts`, `analyze/audit-graph.ts` (`%vlocity_namespace%`), `analyze/wip-impact.ts` (`vlocity/datapacks`), `ingest/detect-deletions-guard.ts` | Special cases by label or path. |
| MCP tools and skills | `packages/mcp-server/src/tools/cross_layer_flow_map.ts`, `_plain.ts`, and others; `packages/skills/skills/sf-omnistudio-migration-audit` | Hard-coded OS/IP/DR edge and label lists. |

Building blocks that already exist:

- the capability probe;
- `--only <source>` source selection;
- the per-org graph stamps: member-row generation (1.6.0) and sync generation.

## Design

### The contract

```ts
interface CloudPack {
  id: string;                         // "core", "vlocity-cmt", "omnistudio", "omni-bridge", ...
  version: string;                    // recorded in the graph (see "Selection")
  requires?: string[];                // other packs this one builds on
  /** Is this cloud present? Live: from the capability probe. Project: from the tree. */
  detect(ctx: { caps?: OrgCapabilities; project?: ProjectLayout }): boolean;

  domain?: {
    labels?: LabelSpec[];             // node labels this pack emits
    relTypes?: RelTypeSpec[];         // edge types (namespaced, see below)
    categories?: CategorySpec[];
  };
  extractors?: {
    live?: LiveSourceSpec[];          // name, timeout, iterator factory
    filesystem?: FsWalkerSpec[];      // directories / globs it owns
    probes?: CapabilityProbe[];       // extra describe() calls it needs
  };
  routes?: Record<string, ParserId>;  // metadata type -> parser (replaces the switch)
  parsers?: Parser[];                 // explicit registration (no side effects)
  parserHooks?: {
    apexCallSite?: ApexCallSiteHook[];  // e.g. vlocity remote-action calls
    lwcModule?: LwcModuleHook[];        // e.g. omnidef
  };
  resolvers?: Array<{ id: string; after?: string[]; scopedForDelta?: boolean; run(ctx: PostMergeCtx): ResolverResult }>;
  analysis?: { livenessRules?: LivenessRule[]; pathHints?: string[] };
  mcp?: { plainLabels?: Record<string, string>; flowEdgeSets?: Record<string, string[]> };
}
```

### Rules that keep it from rotting

1. **One-way dependency.** Core defines the contract and the host loops, and never imports a pack. Packs depend on core. A lint rule (or a dependency-cruiser check) enforces that `packages/core` does not import from `packages/cloud-*`.
2. **Explicit registration.** The CLI and the MCP server build a `PackRegistry` from a list, for example `[corePack, vlocityPack, omnistudioPack, omniBridgePack]`. Packs do not register through side-effect imports.
3. **Cross-cloud logic lives in a bridge pack.** Vlocity ↔ OmniStudio `CANONICAL_OF`, the cross-flavor resolver and the overlap detector go into `omni-bridge`, which `requires: ["vlocity-cmt", "omnistudio"]`. The two clouds never import each other.
4. **Namespaced types.** Edge types and labels contributed by a pack keep their current names, such as `DR_READS_FIELD` and `OmniProcess`, so nothing changes for existing graphs. The registry rejects duplicate names across packs at startup. New packs prefix where a collision is plausible.
5. **Core is a pack too.** The platform parsers and resolvers register the same way. The host has no "default cloud" branches.

### Selection

1. **Auto-detect is the default.** Each pack's `detect()` runs against the capability probe (live) or the tree (project).
2. **Explicit override.** Per-org config, `clouds: ["core", "vlocity-cmt"]`, and `sfgraph ingest --clouds core,vlocity-cmt`. Explicit selection wins over detection. A selected pack whose `detect()` is false logs a warning but still runs.
3. **`requires` closure.** Selecting `omni-bridge` pulls in both of its dependencies.
4. **The graph records the pack set.** It is stored as `{ id, version }[]`, alongside the member-row generation added in 1.6.0. A delta under a different pack set, or a different pack version, runs a full rebuild, for the same reason a parser upgrade does: unchanged members would otherwise keep the other configuration's output.
5. **The MCP server reads the recorded pack set** to decide which tool views and edge sets to expose for that org.

### Packaging

```
packages/core              host: contract, registry, loops, platform pack
packages/cloud-vlocity     legacy Vlocity / Communications Cloud
packages/cloud-omnistudio  OmniStudio on core
packages/cloud-omni-bridge Vlocity <-> OmniStudio canonical mapping
```

All first-party, all in this monorepo, all versioned with the release. Third-party loading is a later decision, if ever. It brings code-execution, trust and version-skew questions that first-party packs avoid.

## Migration plan

One step per PR. Each must leave graph output byte-identical: the golden parser tests plus `bench/lib/graph-dump.mjs` and `normalise.mjs` diffs on a Vlocity fixture project and a core-only one.

1. **Contract and registry, resolvers first.** Add `CloudPack`, `PackRegistry` and the post-merge loop with `after` ordering. Move the five Vlocity/OmniStudio resolvers into pack definitions that still live in core. The `disable*` options become "pack or resolver not selected". These resolvers are the least entangled piece.
2. **Routing and parser registration.** Replace the `parse-member.ts` switch and `VLOCITY_MEMBER_TO_PARSER` with `routes`, and the side-effect imports in `parsers/index.ts` with explicit `parsers`.
3. **Extraction.** Replace the `if (caps.…)` fan-out in `bulk-retrieve.ts` and `dispatch.ts` with pack `extractors.live`, plus `detect()`. Do the same for the filesystem walker list.
4. **Parser hooks.** Extract `vlocity-calls.ts` and `omnidef.ts` behind `apexCallSite` and `lwcModule` hook points. This is the most delicate step. It needs a hook design that keeps each core parser a single pass.
5. **Domain.** Make the edge-type, label and category registries extensible, merged from packs at startup. Keep the TypeScript types: each pack exports its literal union, and the host type is the union of the selected packs.
6. **Analysis and MCP.** Move liveness rules, path hints, `_plain` labels and `cross_layer_flow_map` edge sets into packs.
7. **Split the packages.** Move pack code out of `packages/core` into `packages/cloud-*`. Add `--clouds`, the config key and the recorded pack set.

## Risks / open questions

- **Qualified-name and edge-type stability.** Renaming anything breaks every existing graph and snapshot diff. The rule is no renames during the migration.
- **Over-generalising early.** Design the hooks around what Vlocity and OmniStudio need now. Revisit when the third cloud arrives, rather than guessing at its needs.
- **Hook cost in hot parsers.** Apex and LWC hooks run per member. Keep them synchronous and allocation-light, and profile with the 1.6.0 bench numbers as the baseline.
- **Delta scoping.** Some resolvers re-derive globally on every delta, and others are scoped (`ingest/delta.ts`). A resolver must declare which kind it is (`scopedForDelta`) so the delta path stays correct.
- **Org-level detection gaps.** A failed probe today turns into a skip, not an error. With explicit selection, decide whether a selected pack's failed probe should be a hard error or a warning.
