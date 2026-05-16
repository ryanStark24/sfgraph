export * from "./domain/index.js";
export * from "./telemetry/index.js";
export * from "./extractors/live-org/index.js";
export * from "./storage/index.js";
export * from "./ingest/index.js";
export * from "./embedding/index.js";
export type {
  MetadataSource,
  MemberRef,
  RawMember,
} from "./extractors/interfaces/metadata-source.js";
export { FilesystemMetadataSource } from "./extractors/filesystem/index.js";
export * as render from "./render/mermaid/index.js";
export * as analyze from "./analyze/index.js";
// Top-level re-exports of the graph-audit API for CLI/host consumers.
export {
  auditDanglingEdges,
  deleteDanglingEdges,
  type AuditResult,
  type AuditOpts,
  type DanglingEdgeSample,
} from "./analyze/audit-graph.js";
export type { ToolResponse } from "./tools/types.js";
