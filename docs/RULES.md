# User rule files

sfgraph can parse a new Salesforce metadata type, or one a newer API version added, without a release. Write a YAML rule, point sfgraph at the directory, and ingest.

```bash
sfgraph ingest --org my-org --rules-dir ./sfgraph-rules
# or
SFGRAPH_RULES_DIR=./sfgraph-rules sfgraph ingest --org my-org
```

`--rules-dir` sets `SFGRAPH_RULES_DIR` for the run, so the parse workers see it too. The directory is read once per process; every `*.yml` / `*.yaml` file in it is a rule (files starting with `_` are ignored).

## What you get without writing a rule

A type with no rule is still ingested: every type the org's `describeMetadata` lists reaches the generic path. It becomes a node holding its name and size, plus a short list of candidate references the generic scanner found in the body (Apex class names, Flow API names, `ns__Name__c` objects, `Object.Field` paths, `{!$Record.Field}` merge fields, and values under element names like `*object*`, `*apexClass*`, `*flow*`, `*actionName*`, `*field*`). After the merge, each candidate that matches a real node becomes a heuristic edge:

| Edge | Target |
|---|---|
| `GENERIC_REFERENCES_APEX` | `ApexClass:` / `ApexInterface:` |
| `GENERIC_REFERENCES_FLOW` | `Flow:` |
| `GENERIC_REFERENCES_OBJECT` | `CustomObject:` |
| `GENERIC_REFERENCES_FIELD` | `CustomField:Object.Field` |

Edge attributes: `via` (the element path), `confidence: heuristic`, `source: generic-scan`, `targetKind`. Candidates that match nothing are dropped. A rule gives you exact edges instead.

## Rule format

The same schema as the built-in rules in `packages/core/src/parsers/rules/` (see `_schema.ts`; the selector syntax is documented at the top of `_selectors.ts`).

| Key | Meaning |
|---|---|
| `type` | The metadata type name, exactly as `describeMetadata` spells it (`Layout`, `GenAiPlugin`). Members of this type are sent to the rule. |
| `category` | A label for the family (free text). |
| `input` | `xml-string` for metadata (a live read arrives as JSON, a project checkout as XML; both work), `json` or `object`. |
| `root` | Root element after XML parsing (usually the type name). |
| `applies_when` | `always: true`, or a `capability` / `not` / `any_of` / `all_of` predicate. |
| `nodes` | Nodes to emit: `label`, `qname`, `props`; `iterate` repeats per array element, `when` makes it conditional. |
| `edges` | Edges to emit: `relType`, `src`, `dst`, `props`, `iterate`, `when`. |
| `override` | `true` replaces a built-in parser of the same `type`. Only meaningful in a user file. |

Selectors: `${record.field}`, `${item.field}` (inside `iterate`), `${a || b}`, `${x | raw}` (no namespace strip), `${stripNs(x)}`, `${a == 'v'}`. `relType` must be an existing edge kind (see `packages/core/src/domain/rel-types.ts`); `REFERENCES` is the safe general one. Name the destination the way the target's node is named: `ApexClass:<name>`, `Flow:<name>`, `CustomObject:<name>`, `CustomField:<Object>.<Field>`.

## Example: a made-up type

`sfgraph-rules/widget-config.yml` for a type `WidgetConfig` whose body looks like `<WidgetConfig><object>Order__c</object><handler>OrderHandler</handler><steps><flowName>Ship_Order</flowName></steps></WidgetConfig>`:

```yaml
type: WidgetConfig
category: WidgetConfig
input: xml-string
root: WidgetConfig
applies_when:
  always: true

nodes:
  - label: WidgetConfig
    qname: "WidgetConfig:${record.name}"
    props:
      name: "${record.name}"
      object: "${record.object}"

edges:
  - relType: REFERENCES_OBJECT
    when: "${record.object}"
    src: "WidgetConfig:${record.name}"
    dst: "CustomObject:${record.object}"

  - relType: REFERENCES
    when: "${record.handler}"
    src: "WidgetConfig:${record.name}"
    dst: "ApexClass:${record.handler}"
    props:
      via: handler

  - relType: FLOW_INVOKES_SUBFLOW
    iterate: "${record.steps}"
    when: "${item.flowName}"
    src: "WidgetConfig:${record.name}"
    dst: "Flow:${item.flowName}"
```

## Loading rules

- Rules are validated with the built-in schema. A file that is not valid YAML, or does not match the schema, is skipped with a warning on stderr (`sfgraph: rules-dir: skipped <file>: <reason>`). Ingest never fails because of a user rule file, and an unreadable directory is only a warning.
- A built-in parser wins on a type-name clash: the user file is skipped with a warning. Set `override: true` to replace it. Override only works for types that go through the generic dispatch; types with hand-written inputs (`ApexClass`, `Flow`, `CustomObject`, `Profile`, `PermissionSet`, the OmniStudio and Vlocity types) receive their own input shape and should not be overridden.
- Two files in the directory defining the same `type`: the first (by file name) wins.
- A new type's members only appear if the org lists the type in `describeMetadata`. The rule only changes how a listed member is parsed.
- Check what is still name-only with the coverage report: `staleness_check` returns `data.coverage` (per type: `opaque`, `nameOnly`, `withGenericEdges`, `ruleParsed`, plus `unknownTypes`).
