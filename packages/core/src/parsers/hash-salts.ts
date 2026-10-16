/**
 * Every parser hash salt, in one place (cycle 3 final review I-1). A salt is folded into a node's
 * content hash; bump it when a parser emits new attributes for unchanged input, because the graph
 * merge only rewrites attributes when the hash changes. The member-row generation
 * (`memberRowsGeneration`) hashes all of them, so a salt bump also makes `--delta` rebuild instead
 * of keeping old output for unchanged members.
 */

// object/object.ts
/**
 * Folded into the content hash of source-file CustomField nodes. Bump it when
 * the parser starts emitting new attributes for unchanged XML: the graph merge
 * only rewrites attributes when the hash changes, so a plain re-ingest would
 * otherwise keep the old attributes. v2: referenceTo / relationshipName.
 */
export const FIELD_NODE_HASH_SALT = "custom-field-attrs:v2";

// object/object.ts
/**
 * Same idea for the CustomObject / PlatformEvent node built from the object
 * XML. v2: customSettingsType.
 */
export const OBJECT_NODE_HASH_SALT = "custom-object-attrs:v2";

// apex/class.ts
/**
 * Salt for ApexClass / ApexInterface / ApexMethod node hashes. Bump it when a
 * parser change alters node attributes or qnames for unchanged source: node
 * merge keeps the stored attributes when `sourceHash` is unchanged, so without
 * a bump a re-ingest would leave e.g. stale `modifiers` in place.
 * v2: generic-aware header / arity parsing (audit corecorr-01, dangling-06).
 * v4: inline SOQL ends at its depth-0 `]` (relationship paths from the full
 * query) and `dynamicSoqlFieldsSkipped`.
 * v5: `dynamicSoqlFieldsSkipped` also counts rejected literal-FROM queries.
 * v6: a top-level enum gets its `modifiers`; the empty-body stub gets `bodyUnavailable`.
 * v7: a guard-bound dynamic FROM is no longer counted in `dynamicSoqlFieldsSkipped`.
 * v8: the guard check ignores `(`, `||` and `&&` inside string literals, and
 * treats `+=` and the like as a reassignment, so the skipped-field count can change.
 * v9: `apexChildRelationships` (child-relationship subqueries).
 * v10: a dynamic SOQL string with a literal (or guard-proven) FROM also links
 * to its object (EXECUTES_SOQL `{dynamic: true}`).
 * v11: `apexFieldNameLiterals` (custom field names passed as text).
 */
export const APEX_NODE_HASH_SALT = "apex-attrs:v12";

// vlocity/data-raptor.ts
/**
 * Folded into the DataRaptor node's content hash. Bump it when the parser
 * starts emitting new node attributes for an unchanged pack: the graph merge
 * only rewrites attributes on a hash change. v2: drRelationshipPaths.
 */
export const DATARAPTOR_NODE_HASH_SALT = "dataraptor-attrs:v2";

// vlocity/common.ts
/** Hash salt shared by the OS/IP/Card parsers: bump when emitted edge attrs
 *  change so incremental ingests re-parse. v2: inactive=true tagging. */
export const VLOCITY_ELEMENT_HASH_SALT = "vlocity-elements:v3";

// aura/bundle.ts
/** Folded into the AuraComponent node hash. Bump it when the parser emits new
 *  output for an unchanged bundle so `--delta` re-parses it. v2: server-action
 *  IMPORTS_APEX edges, empApi / lightning:messageChannel event edges. */
export const AURA_NODE_HASH_SALT = "aura-attrs:v2";

// lwc/bundle.ts
/**
 * Folded into the LWC / LWCBundle node hash. Bump it when the node attributes
 * change so a plain re-ingest re-merges unchanged bundles. v2: recordFieldKeys.
 * v3: recordObjects (static object context for the field-key resolver).
 * v4: a lightning record form's literal `object-api-name` links to its object.
 * v5: `'Object.Field'` string fields (uiRecordApi, record forms) link to their
 * field; empApi / Lightning Message Service event edges.
 */
export const LWC_NODE_HASH_SALT = "lwc-attrs:v5";

// generic/opaque-node-parser.ts
export const OPAQUE_DATAPACK_HASH_SALT = "vlocity-datapack-refs:v2";

// flow/parser.ts
/**
 * Folded into the Flow node hash. Bump it when the Flow parser emits new node
 * attributes or different edges for unchanged XML. v1: flowRelationshipPaths;
 * bulk-update collection writes, no field read for an inputReference, and
 * PUBLISHES_EVENT / SUBSCRIBES_TO_EVENT.
 */
export const FLOW_NODE_HASH_SALT = "flow-attrs:v1";

/** Every salt above; a new salt must be added here. */
export const HASH_SALTS: readonly string[] = [
  FIELD_NODE_HASH_SALT,
  OBJECT_NODE_HASH_SALT,
  APEX_NODE_HASH_SALT,
  DATARAPTOR_NODE_HASH_SALT,
  VLOCITY_ELEMENT_HASH_SALT,
  AURA_NODE_HASH_SALT,
  LWC_NODE_HASH_SALT,
  OPAQUE_DATAPACK_HASH_SALT,
  FLOW_NODE_HASH_SALT,
];
