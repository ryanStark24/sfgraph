"""Graph query and lineage service with evidence-first outputs."""
from __future__ import annotations

import json
import re
import subprocess
import time
from collections import deque
from pathlib import Path
from typing import Any

from sfgraph.query.agents import (
    QueryCorrectorAgent,
    QueryPlannerAgent,
    ResultFormatterAgent,
    SchemaFilterAgent,
)
from sfgraph.query.rules_registry import RulesRegistry
from sfgraph.storage.base import GraphStore
from sfgraph.storage.manifest_store import ManifestStore
from sfgraph.storage.vector_store import VectorStore


def _parse_props(value: Any) -> dict[str, Any]:
    if isinstance(value, dict):
        return value
    if isinstance(value, str):
        try:
            parsed = json.loads(value)
            if isinstance(parsed, dict):
                return parsed
        except Exception:
            return {}
    return {}


def _semantic_kind(rel_type: str, context: str) -> str:
    ctx = context.lower()
    if rel_type == "QUERIES_OBJECT":
        return "soql_where" if " where " in f" {ctx} " else "soql_select"
    if rel_type == "DML_ON":
        if ctx.startswith("insert"):
            return "dml_insert"
        if ctx.startswith("update"):
            return "dml_update"
        if ctx.startswith("delete"):
            return "dml_delete"
        return "dml_mutation"
    if rel_type == "DR_WRITES":
        return "dr_output"
    if rel_type in {"FLOW_READS_FIELD", "FLOW_READS_VALUE"}:
        return "flow_filter"
    if rel_type in {"WIRES_ADAPTER", "CONTAINS_CHILD"}:
        return "ui_bind"
    if rel_type in {"READS_FIELD", "FLOW_WRITES_FIELD", "WRITES_FIELD"}:
        return "field_access"
    return rel_type.lower()


class GraphQueryService:
    """Provides lineage and query helpers over the current graph store."""

    def __init__(
        self,
        graph: GraphStore,
        manifest: ManifestStore,
        vectors: VectorStore | None = None,
        repo_root: str | None = None,
        ingestion_meta_path: str = "./data/ingestion_meta.json",
        ingestion_progress_path: str = "./data/ingestion_progress.json",
        rules_path: str | None = None,
    ) -> None:
        self._graph = graph
        self._manifest = manifest
        self._vectors = vectors
        self._repo_root = Path(repo_root or Path(__file__).resolve().parents[3])
        self._ingestion_meta_path = Path(ingestion_meta_path)
        self._ingestion_progress_path = Path(ingestion_progress_path)
        self._rules = RulesRegistry(config_path=rules_path)
        self._schema_agent = SchemaFilterAgent()
        self._planner_agent = QueryPlannerAgent()
        self._corrector_agent = QueryCorrectorAgent()
        self._formatter_agent = ResultFormatterAgent()
        self._labels_cache: list[str] | None = None
        self._rel_cache: list[str] | None = None
        self._node_cache: dict[str, dict[str, Any] | None] = {}

    async def _labels(self) -> list[str]:
        if self._labels_cache is None:
            self._labels_cache = await self._graph.get_labels()
        return self._labels_cache

    async def _rel_types(self) -> list[str]:
        if self._rel_cache is None:
            self._rel_cache = await self._graph.get_relationship_types()
        return self._rel_cache

    def _read_ingestion_meta(self) -> dict[str, Any]:
        if not self._ingestion_meta_path.exists():
            return {}
        try:
            payload = json.loads(self._ingestion_meta_path.read_text(encoding="utf-8"))
            return payload if isinstance(payload, dict) else {}
        except Exception:
            return {}

    def _read_ingestion_progress(self) -> dict[str, Any]:
        if not self._ingestion_progress_path.exists():
            return {}
        try:
            payload = json.loads(self._ingestion_progress_path.read_text(encoding="utf-8"))
            return payload if isinstance(payload, dict) else {}
        except Exception:
            return {}

    def _current_commit(self) -> str | None:
        try:
            result = subprocess.run(
                ["git", "rev-parse", "HEAD"],
                cwd=str(self._repo_root),
                check=True,
                capture_output=True,
                text=True,
            )
            return result.stdout.strip()
        except Exception:
            return None

    def _current_scope(self) -> str | None:
        meta = self._read_ingestion_meta()
        scope = meta.get("project_scope")
        if not scope:
            return None

        export_dir = meta.get("export_dir")
        if export_dir:
            try:
                export_path = Path(str(export_dir)).expanduser().resolve()
                if export_path != self._repo_root and self._repo_root not in export_path.parents:
                    return None
            except Exception:
                return None

        return str(scope)

    @staticmethod
    def _descope_qname(qualified_name: str) -> str:
        if "::" not in qualified_name:
            return qualified_name
        return qualified_name.split("::", 1)[1]

    def _scope_qname(self, qualified_name: str) -> str:
        if not qualified_name:
            return qualified_name
        if "::" in qualified_name:
            return qualified_name
        scope = self._current_scope()
        if not scope:
            return qualified_name
        return f"{scope}::{qualified_name}"

    def _is_in_scope(self, qualified_name: str) -> bool:
        scope = self._current_scope()
        if not scope:
            return True
        return qualified_name.startswith(f"{scope}::")

    async def freshness(self, partial_results: bool = False) -> dict[str, Any]:
        meta = self._read_ingestion_meta()
        pending = await self._manifest.get_pending_files(limit=500)
        return {
            "indexed_commit": meta.get("indexed_commit") or self._current_commit(),
            "indexed_at": meta.get("indexed_at"),
            "project_scope": meta.get("project_scope"),
            "export_dir": meta.get("export_dir"),
            "dirty_files_pending": len(pending),
            "partial_results": partial_results,
        }

    async def _find_node(self, qualified_name: str) -> dict[str, Any] | None:
        cache_key = f"{self._current_scope() or 'no-scope'}::{qualified_name}"
        if cache_key in self._node_cache:
            return self._node_cache[cache_key]

        scoped_qname = self._scope_qname(qualified_name)

        for label in await self._labels():
            try:
                rows = await self._graph.query(
                    f'SELECT qualified_name, props FROM "{label}" WHERE qualified_name = $qn LIMIT 1',
                    {"qn": scoped_qname},
                )
            except Exception:
                rows = []
            if not rows:
                # Fallback for legacy unscoped rows and flexible lookup.
                try:
                    fallback_rows = await self._graph.query(
                        f'SELECT qualified_name, props FROM "{label}" LIMIT 5000'
                    )
                except Exception:
                    fallback_rows = []
                for row in fallback_rows:
                    row_qname = str(row.get("qualified_name", ""))
                    if not row_qname:
                        continue
                    if self._descope_qname(row_qname) != qualified_name and row_qname != qualified_name:
                        continue
                    if not self._is_in_scope(row_qname):
                        continue
                    props = _parse_props(row.get("props"))
                    result = {
                        "qualifiedName": self._descope_qname(row_qname),
                        "scopedQualifiedName": row_qname,
                        "label": label,
                        "props": props,
                    }
                    self._node_cache[cache_key] = result
                    return result
                continue

            row_qname = str(rows[0].get("qualified_name", ""))
            if not row_qname:
                continue
            props = _parse_props(rows[0].get("props"))
            result = {
                "qualifiedName": self._descope_qname(row_qname),
                "scopedQualifiedName": row_qname,
                "label": label,
                "props": props,
            }
            self._node_cache[cache_key] = result
            return result

        self._node_cache[cache_key] = None
        return None

    async def _edges_for_node(self, qualified_name: str, direction: str) -> list[dict[str, Any]]:
        rows_out: list[dict[str, Any]] = []
        scoped_qname = self._scope_qname(qualified_name)
        for rel in await self._rel_types():
            try:
                if direction == "out":
                    rows = await self._graph.query(
                        f'SELECT src_qualified_name, dst_qualified_name, props FROM "{rel}" WHERE src_qualified_name = $qn',
                        {"qn": scoped_qname},
                    )
                else:
                    rows = await self._graph.query(
                        f'SELECT src_qualified_name, dst_qualified_name, props FROM "{rel}" WHERE dst_qualified_name = $qn',
                        {"qn": scoped_qname},
                    )
            except Exception:
                rows = []
            for row in rows:
                src_scoped = str(row.get("src_qualified_name", ""))
                dst_scoped = str(row.get("dst_qualified_name", ""))
                if not src_scoped or not dst_scoped:
                    continue
                if not self._is_in_scope(src_scoped) or not self._is_in_scope(dst_scoped):
                    continue
                props = _parse_props(row.get("props"))
                context = str(props.get("contextSnippet", ""))
                semantic = self._rules.semantic_override(rel, context) or _semantic_kind(rel, context)
                resolution_method = str(props.get("resolutionMethod", "unknown"))
                unresolved_dynamic = (
                    resolution_method in {"dynamic", "unknown", "traced_limit", "regex"}
                    or self._descope_qname(src_scoped).startswith("UNRESOLVED.")
                    or self._descope_qname(dst_scoped).startswith("UNRESOLVED.")
                )
                rows_out.append(
                    {
                        "src": self._descope_qname(src_scoped),
                        "dst": self._descope_qname(dst_scoped),
                        "src_scoped": src_scoped,
                        "dst_scoped": dst_scoped,
                        "rel_type": rel,
                        "confidence": float(props.get("confidence", 0.5)),
                        "resolutionMethod": resolution_method,
                        "edgeCategory": props.get("edgeCategory", "DATA_FLOW"),
                        "contextSnippet": context,
                        "semantic": semantic,
                        "is_unresolved_dynamic": unresolved_dynamic,
                    }
                )
        return rows_out

    async def _trace(
        self,
        start_node: str,
        direction: str,
        max_hops: int,
        max_results: int,
        time_budget_ms: int,
        offset: int = 0,
    ) -> dict[str, Any]:
        start_time = time.monotonic()
        normalized_start = self._descope_qname(start_node)
        queue: deque[tuple[str, list[dict[str, Any]], set[str], int]] = deque()
        queue.append((normalized_start, [], {normalized_start}, 0))

        findings: list[dict[str, Any]] = []
        produced = 0
        partial = False
        trace_limit_hit = False
        unknown_dynamic_edges_count = 0

        while queue:
            if (time.monotonic() - start_time) * 1000 > time_budget_ms:
                partial = True
                break

            node, path, seen, depth = queue.popleft()
            if depth >= max_hops:
                if queue:
                    trace_limit_hit = True
                continue

            for edge in await self._edges_for_node(node, direction):
                next_node = edge["dst"] if direction == "out" else edge["src"]
                if not next_node or next_node in seen:
                    continue

                src_meta = await self._find_node(edge["src"])
                source_file = src_meta["props"].get("sourceFile") if src_meta else None
                source_line = src_meta["props"].get("lineNumber") if src_meta else None

                step = {
                    **edge,
                    "source_file": source_file,
                    "source_line": source_line,
                }
                new_path = path + [step]
                if step.get("is_unresolved_dynamic"):
                    unknown_dynamic_edges_count += 1

                produced += 1
                if produced > offset:
                    confidence = min((float(s.get("confidence", 0.5)) for s in new_path), default=0.5)
                    findings.append(
                        {
                            "target_node": next_node,
                            "hops": len(new_path),
                            "confidence": round(confidence, 3),
                            "path": new_path,
                        }
                    )
                    if len(findings) >= max_results:
                        partial = True
                        break

                queue.append((next_node, new_path, seen | {next_node}, depth + 1))

            if partial:
                break

        freshness = await self.freshness(partial_results=partial)
        return {
            "start_node": normalized_start,
            "direction": direction,
            "findings": findings,
            "trace_limit_hit": trace_limit_hit,
            "limits": {
                "max_hops": max_hops,
                "max_results": max_results,
                "time_budget_ms": time_budget_ms,
                "offset": offset,
            },
            "freshness": freshness,
            "partial_results": partial,
            "unknown_dynamic_edges_count": unknown_dynamic_edges_count,
        }

    async def trace_downstream(
        self,
        start_node: str,
        max_hops: int = 3,
        max_results: int = 50,
        time_budget_ms: int = 1500,
        offset: int = 0,
    ) -> dict[str, Any]:
        return await self._trace(start_node, "out", max_hops, max_results, time_budget_ms, offset)

    async def trace_upstream(
        self,
        start_node: str,
        max_hops: int = 3,
        max_results: int = 50,
        time_budget_ms: int = 1500,
        offset: int = 0,
    ) -> dict[str, Any]:
        return await self._trace(start_node, "in", max_hops, max_results, time_budget_ms, offset)

    async def get_node(self, node_id: str) -> dict[str, Any]:
        node = await self._find_node(node_id)
        outgoing = await self._edges_for_node(node_id, "out")
        incoming = await self._edges_for_node(node_id, "in")

        return {
            "node": node,
            "outgoing_edges": outgoing,
            "incoming_edges": incoming,
            "freshness": await self.freshness(partial_results=False),
        }

    async def explain_field(self, field_qualified_name: str) -> dict[str, Any]:
        upstream = await self.trace_upstream(field_qualified_name, max_hops=3, max_results=100)
        downstream = await self.trace_downstream(field_qualified_name, max_hops=3, max_results=100)

        readers = [f for f in upstream["findings"] if f["path"] and f["path"][-1]["rel_type"] in {"READS_FIELD", "FLOW_READS_FIELD", "WIRES_ADAPTER", "DR_READS"}]
        writers = [f for f in upstream["findings"] if f["path"] and f["path"][-1]["rel_type"] in {"WRITES_FIELD", "FLOW_WRITES_FIELD", "DR_WRITES"}]
        dependents = downstream["findings"]

        partial = upstream["partial_results"] or downstream["partial_results"]
        return {
            "field": field_qualified_name,
            "readers": readers,
            "writers": writers,
            "dependents": dependents,
            "freshness": await self.freshness(partial_results=partial),
            "partial_results": partial,
        }

    async def query(
        self,
        question: str,
        max_hops: int = 3,
        max_results: int = 50,
        time_budget_ms: int = 1500,
        offset: int = 0,
    ) -> dict[str, Any]:
        q = question.strip()
        schema_filter, schema_trace = await self._schema_filter(q)
        intent = self._intent(q)
        planner_trace = self._planner_agent.run(question=q, intent=intent)
        field_match = None
        match = re.search(r"\b([A-Za-z][A-Za-z0-9_]*\.[A-Za-z][A-Za-z0-9_]*(?:__[A-Za-z0-9_]+)?)\b", q)
        if match:
            field_match = match.group(1)
            field_match = self._rules.resolve_alias(field_match)

        if intent == "trace_upstream" and field_match:
            result = await self.trace_upstream(
                field_match,
                max_hops=max_hops,
                max_results=max_results,
                time_budget_ms=time_budget_ms,
                offset=offset,
            )
            result["mode"] = "trace_upstream"
            result["question"] = q
            result["pipeline"] = {
                "schema_filter": schema_filter,
                "intent": intent,
                "attempts": [],
                "agent_trace": [
                    schema_trace,
                    {"name": planner_trace.name, "strategy": planner_trace.strategy, "detail": planner_trace.detail},
                    {"name": self._formatter_agent.run(len(result.get("findings", []))).name, "strategy": self._formatter_agent.strategy, "detail": self._formatter_agent.run(len(result.get("findings", []))).detail},
                ],
                "formatter": "confidence_tiers",
            }
            result["confidence_tiers"] = self._confidence_tiers(result.get("findings", []))
            return result

        if intent == "trace_downstream" and field_match:
            result = await self.trace_downstream(
                field_match,
                max_hops=max_hops,
                max_results=max_results,
                time_budget_ms=time_budget_ms,
                offset=offset,
            )
            result["mode"] = "trace_downstream"
            result["question"] = q
            result["pipeline"] = {
                "schema_filter": schema_filter,
                "intent": intent,
                "attempts": [],
                "agent_trace": [
                    schema_trace,
                    {"name": planner_trace.name, "strategy": planner_trace.strategy, "detail": planner_trace.detail},
                    {"name": self._formatter_agent.run(len(result.get("findings", []))).name, "strategy": self._formatter_agent.strategy, "detail": self._formatter_agent.run(len(result.get("findings", []))).detail},
                ],
                "formatter": "confidence_tiers",
            }
            result["confidence_tiers"] = self._confidence_tiers(result.get("findings", []))
            return result

        if intent == "cross_layer_flow_map" and field_match:
            result = await self.cross_layer_flow_map(
                start_node=field_match,
                max_hops=max_hops,
                max_results=max_results,
                time_budget_ms=time_budget_ms,
                offset=offset,
            )
            result["question"] = q
            result["pipeline"] = {
                "schema_filter": schema_filter,
                "intent": intent,
                "attempts": [],
                "agent_trace": [
                    schema_trace,
                    {"name": planner_trace.name, "strategy": planner_trace.strategy, "detail": planner_trace.detail},
                    {"name": self._formatter_agent.run(len(result.get("layer_paths", []))).name, "strategy": self._formatter_agent.strategy, "detail": self._formatter_agent.run(len(result.get("layer_paths", []))).detail},
                ],
                "formatter": "confidence_tiers",
            }
            return result

        # Node-search path with generator/correction loop and vector fallback.
        token = field_match or q.split()[-1]
        token = self._rules.resolve_alias(token)
        candidates, attempts = await self._execute_node_search_pipeline(
            token=token,
            labels=schema_filter["labels"],
            max_results=max_results,
            offset=offset,
            max_attempts=4,
        )
        used_vector_fallback = False
        if not candidates:
            vector_hits = await self._vector_fallback(question=q, limit=max_results)
            if vector_hits:
                candidates = vector_hits
                used_vector_fallback = True
                attempts.append(
                    {
                        "attempt": len(attempts) + 1,
                        "label": "vector_fallback",
                        "status": "ok",
                        "rows": len(vector_hits),
                    }
                )

        partial = len(candidates) > max_results
        corrector_trace = self._corrector_agent.run(attempts)
        formatter_trace = self._formatter_agent.run(len(candidates[:max_results]))
        return {
            "mode": "node_search",
            "question": q,
            "candidates": candidates[:max_results],
            "confidence_tiers": self._confidence_tiers(candidates[:max_results]),
            "pipeline": {
                "schema_filter": schema_filter,
                "intent": intent,
                "attempts": attempts,
                "correction_loop_max_attempts": 4,
                "agent_trace": [
                    schema_trace,
                    {"name": planner_trace.name, "strategy": planner_trace.strategy, "detail": planner_trace.detail},
                    {"name": corrector_trace.name, "strategy": corrector_trace.strategy, "detail": corrector_trace.detail},
                    {"name": formatter_trace.name, "strategy": formatter_trace.strategy, "detail": formatter_trace.detail},
                ],
                "hint": "No lexical candidates; used semantic vector fallback."
                if used_vector_fallback
                else "Lexical label-filtered search succeeded.",
            },
            "freshness": await self.freshness(partial_results=partial),
            "partial_results": partial,
        }

    @staticmethod
    def _layer_for_label(label: str) -> str:
        if label in {"LWCComponent", "LWCProperty"}:
            return "UI"
        if label in {"Flow", "FlowElement", "OmniScript"}:
            return "FLOW"
        if label in {"IntegrationProcedure", "IPElement", "IPVariable", "DataRaptor"}:
            return "DATA_PIPELINE"
        if label in {"ApexClass", "ApexMethod", "ApexTrigger"}:
            return "APEX"
        if label in {"SFObject", "SFField", "SFPicklistValue", "GlobalValueSet"}:
            return "DATA_MODEL"
        return "OTHER"

    async def _count_nodes_for_label(self, label: str) -> int:
        if not self._current_scope():
            try:
                rows = await self._graph.query(f'SELECT COUNT(*) AS c FROM "{label}"')
                return int(rows[0].get("c", 0)) if rows else 0
            except Exception:
                return 0

        try:
            rows = await self._graph.query(f'SELECT qualified_name FROM "{label}"')
        except Exception:
            return 0
        return sum(1 for row in rows if self._is_in_scope(str(row.get("qualified_name", ""))))

    async def _count_edges_for_rel(self, rel: str) -> int:
        if not self._current_scope():
            try:
                rows = await self._graph.query(f'SELECT COUNT(*) AS c FROM "{rel}"')
                return int(rows[0].get("c", 0)) if rows else 0
            except Exception:
                return 0

        try:
            rows = await self._graph.query(f'SELECT src_qualified_name, dst_qualified_name FROM "{rel}"')
        except Exception:
            return 0
        return sum(
            1
            for row in rows
            if self._is_in_scope(str(row.get("src_qualified_name", "")))
            and self._is_in_scope(str(row.get("dst_qualified_name", "")))
        )

    @staticmethod
    def _heuristic_schema_filter(question: str, labels: list[str], rels: list[str]) -> dict[str, list[str]]:
        q = question.lower()

        label_hits = [label for label in labels if label.lower() in q]
        rel_hits = [rel for rel in rels if rel.lower() in q]

        keyword_map = {
            "field": ({"SFField"}, {"READS_FIELD", "WRITES_FIELD", "FLOW_WRITES_FIELD", "FLOW_READS_FIELD"}),
            "flow": ({"Flow", "FlowElement"}, {"FLOW_CALLS_APEX", "FLOW_CALLS_SUBFLOW", "FLOW_READS_FIELD"}),
            "lwc": ({"LWCComponent"}, {"WIRES_ADAPTER", "IMPORTS_APEX", "CONTAINS_CHILD"}),
            "apex": ({"ApexClass", "ApexMethod", "ApexTrigger"}, {"CALLS", "DML_ON", "QUERIES_OBJECT"}),
            "dataraptor": ({"DataRaptor"}, {"DR_READS", "DR_WRITES", "DR_TRANSFORMS"}),
            "impact": (set(labels), {"CALLS", "READS_FIELD", "WRITES_FIELD"}),
            "break": (set(labels), {"CALLS", "READS_FIELD", "WRITES_FIELD"}),
            "uses": (set(labels), {"READS_FIELD", "FLOW_READS_FIELD", "WIRES_ADAPTER", "DR_READS"}),
        }
        extra_labels: set[str] = set()
        extra_rels: set[str] = set()
        for keyword, (ls, rs) in keyword_map.items():
            if keyword in q:
                extra_labels |= {label for label in labels if label in ls}
                extra_rels |= {rel for rel in rels if rel in rs}

        filtered_labels = sorted(set(label_hits) | extra_labels)[:10]
        filtered_rels = sorted(set(rel_hits) | extra_rels)[:12]
        if not filtered_labels:
            filtered_labels = labels[:8]
        if not filtered_rels:
            filtered_rels = rels[:10]
        return {"labels": filtered_labels, "relationships": filtered_rels}

    async def _schema_filter(self, question: str) -> tuple[dict[str, list[str]], dict[str, str]]:
        """Schema-filter stage for NL pipeline with agent trace."""
        labels = await self._labels()
        rels = await self._rel_types()
        filtered, trace = self._schema_agent.run(
            question=question,
            labels=labels,
            rels=rels,
            heuristic_filter=self._heuristic_schema_filter,
        )
        return filtered, {
            "name": trace.name,
            "strategy": trace.strategy,
            "detail": trace.detail,
        }

    @staticmethod
    def _intent(question: str) -> str:
        q = question.lower()
        if any(phrase in q for phrase in ["what uses", "who uses", "used by"]):
            return "trace_upstream"
        if any(phrase in q for phrase in ["what breaks", "impact", "blast radius", "blast"]):
            return "trace_downstream"
        if any(phrase in q for phrase in ["cross layer", "end-to-end", "ui to", "flow map"]):
            return "cross_layer_flow_map"
        return "node_search"

    @staticmethod
    def _confidence_tiers(findings: list[dict[str, Any]]) -> dict[str, list[dict[str, Any]]]:
        tiers = {"definite": [], "probable": [], "review_manually": []}
        for finding in findings:
            confidence = float(finding.get("confidence", 0.0))
            if confidence >= 0.9:
                tiers["definite"].append(finding)
            elif confidence >= 0.5:
                tiers["probable"].append(finding)
            else:
                tiers["review_manually"].append(finding)
        return tiers

    async def _execute_node_search_pipeline(
        self,
        token: str,
        labels: list[str],
        max_results: int,
        offset: int,
        max_attempts: int = 4,
    ) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
        candidates: list[dict[str, Any]] = []
        attempts: list[dict[str, Any]] = []
        needle = f"%{token.lower()}%"
        attempts_used = 0

        for label in labels:
            if attempts_used >= max_attempts:
                break
            attempts_used += 1
            sql = f'SELECT qualified_name, props FROM "{label}" WHERE lower(qualified_name) LIKE $needle LIMIT 20'
            try:
                rows = await self._graph.query(sql, {"needle": needle})
                attempts.append({"attempt": attempts_used, "label": label, "status": "ok", "rows": len(rows)})
            except Exception as exc:
                attempts.append(
                    {
                        "attempt": attempts_used,
                        "label": label,
                        "status": "error",
                        "error": str(exc),
                        "hint": "Label may be absent or stale; retrying with next filtered label.",
                    }
                )
                continue

            for row in rows:
                scoped_qname = str(row.get("qualified_name", ""))
                if not scoped_qname or not self._is_in_scope(scoped_qname):
                    continue
                candidates.append(
                    {
                        "qualifiedName": self._descope_qname(scoped_qname),
                        "scopedQualifiedName": scoped_qname,
                        "label": label,
                        "props": _parse_props(row.get("props")),
                        "confidence": 0.6,
                    }
                )
            if len(candidates) >= (max_results + offset):
                break

        return candidates[offset:offset + max_results], attempts

    async def _vector_fallback(
        self,
        question: str,
        limit: int,
    ) -> list[dict[str, Any]]:
        if not self._vectors:
            return []
        try:
            hits = await self._vectors.search(
                query_text=question,
                limit=limit,
                project_scope=self._current_scope(),
            )
        except Exception:
            return []
        out: list[dict[str, Any]] = []
        for hit in hits:
            node_id = str(hit.get("node_id", ""))
            scoped = node_id if "::" in node_id else self._scope_qname(node_id)
            out.append(
                {
                    "qualifiedName": self._descope_qname(scoped),
                    "scopedQualifiedName": scoped,
                    "label": str(hit.get("payload", {}).get("label", "Unknown")),
                    "props": hit.get("payload", {}),
                    "confidence": float(hit.get("score", 0.5)),
                    "vector_score": float(hit.get("score", 0.5)),
                }
            )
        return out

    async def cross_layer_flow_map(
        self,
        start_node: str,
        max_hops: int = 5,
        max_results: int = 50,
        time_budget_ms: int = 2500,
        offset: int = 0,
    ) -> dict[str, Any]:
        """Map lineage across UI/Flow/Data/Apex/Data-model layers in one call."""
        trace = await self.trace_downstream(
            start_node=start_node,
            max_hops=max_hops,
            max_results=max_results,
            time_budget_ms=time_budget_ms,
            offset=offset,
        )

        layer_paths: list[dict[str, Any]] = []
        coverage: dict[str, int] = {"UI": 0, "FLOW": 0, "DATA_PIPELINE": 0, "APEX": 0, "DATA_MODEL": 0, "OTHER": 0}
        for finding in trace.get("findings", []):
            layers: list[str] = []
            nodes_in_path: list[dict[str, Any]] = []
            if not finding.get("path"):
                continue

            for step in finding["path"]:
                for node_qn in (step["src"], step["dst"]):
                    node_meta = await self._find_node(node_qn)
                    label = node_meta["label"] if node_meta else "Unknown"
                    layer = self._layer_for_label(label)
                    if nodes_in_path and nodes_in_path[-1]["qualifiedName"] == node_qn:
                        continue
                    nodes_in_path.append(
                        {
                            "qualifiedName": node_qn,
                            "label": label,
                            "layer": layer,
                        }
                    )
                    if not layers or layers[-1] != layer:
                        layers.append(layer)

            for layer in set(n["layer"] for n in nodes_in_path):
                coverage[layer] = coverage.get(layer, 0) + 1

            layer_paths.append(
                {
                    "target_node": finding["target_node"],
                    "hops": finding["hops"],
                    "confidence": finding["confidence"],
                    "layers": layers,
                    "nodes": nodes_in_path,
                    "path": finding["path"],
                }
            )

        return {
            "mode": "cross_layer_flow_map",
            "start_node": start_node,
            "layer_paths": layer_paths,
            "coverage": coverage,
            "trace_limit_hit": trace.get("trace_limit_hit", False),
            "limits": trace.get("limits", {}),
            "freshness": trace.get("freshness"),
            "partial_results": trace.get("partial_results", False),
            "unknown_dynamic_edges_count": trace.get("unknown_dynamic_edges_count", 0),
        }

    async def list_unknown_dynamic_edges(self, limit: int = 200, offset: int = 0) -> dict[str, Any]:
        """Return unresolved/dynamic edges explicitly for honesty in impact output."""
        findings: list[dict[str, Any]] = []
        matched = 0

        for rel in await self._rel_types():
            try:
                rows = await self._graph.query(
                    f'SELECT src_qualified_name, dst_qualified_name, props FROM "{rel}"'
                )
            except Exception:
                rows = []

            for row in rows:
                props = _parse_props(row.get("props"))
                resolution_method = str(props.get("resolutionMethod", "unknown"))
                src = str(row.get("src_qualified_name", ""))
                dst = str(row.get("dst_qualified_name", ""))
                if not src or not dst:
                    continue
                if not self._is_in_scope(src) or not self._is_in_scope(dst):
                    continue
                unresolved_dynamic = (
                    resolution_method in {"dynamic", "unknown", "traced_limit", "regex"}
                    or self._descope_qname(src).startswith("UNRESOLVED.")
                    or self._descope_qname(dst).startswith("UNRESOLVED.")
                )
                if not unresolved_dynamic:
                    continue
                if matched < offset:
                    matched += 1
                    continue
                matched += 1
                findings.append(
                    {
                        "rel_type": rel,
                        "src_qualified_name": self._descope_qname(src),
                        "dst_qualified_name": self._descope_qname(dst),
                        "src_scoped_qualified_name": src,
                        "dst_scoped_qualified_name": dst,
                        "resolutionMethod": resolution_method,
                        "confidence": float(props.get("confidence", 0.0)),
                        "contextSnippet": props.get("contextSnippet", ""),
                    }
                )
                if len(findings) >= limit:
                    break
            if len(findings) >= limit:
                break

        visible = findings[:limit]
        partial = matched > (offset + len(visible))
        return {
            "count": len(visible),
            "findings": visible,
            "limits": {"limit": limit, "offset": offset},
            "freshness": await self.freshness(partial_results=partial),
            "partial_results": partial,
        }

    async def get_ingestion_status(self) -> dict[str, Any]:
        labels = await self._labels()
        rel_types = await self._rel_types()

        node_counts: dict[str, int] = {}
        for label in labels:
            node_counts[label] = await self._count_nodes_for_label(label)

        edge_counts: dict[str, int] = {}
        for rel in rel_types:
            edge_counts[rel] = await self._count_edges_for_rel(rel)

        status_counts = await self._manifest.get_status_counts()
        latest_run = await self._manifest.get_latest_completed_run()
        pending = await self._manifest.get_pending_files(limit=200)
        meta = self._read_ingestion_meta()
        progress = await self.get_ingestion_progress()

        return {
            "node_counts_by_type": node_counts,
            "edge_counts_by_type": edge_counts,
            "status_counts": status_counts,
            "latest_completed_run": latest_run,
            "dirty_files_pending": len(pending),
            "parser_stats": meta.get("parser_stats", {}),
            "unresolved_symbols": int(meta.get("unresolved_symbols", 0) or 0),
            "rules": self._rules.describe(),
            "active_run": progress if progress.get("state") == "running" else None,
            "freshness": await self.freshness(partial_results=False),
        }

    async def get_ingestion_progress(self) -> dict[str, Any]:
        progress = self._read_ingestion_progress()
        if not progress:
            return {
                "available": False,
                "state": "idle",
                "freshness": await self.freshness(partial_results=False),
            }

        progress = dict(progress)
        progress["available"] = True
        progress["freshness"] = await self.freshness(partial_results=progress.get("state") == "running")
        return progress

    async def _find_nodes_by_source_files(self, changed_files: list[str], limit: int = 500) -> list[dict[str, Any]]:
        """Best-effort mapping from changed file paths to graph nodes."""
        normalized = [str(Path(p)).replace("\\", "/") for p in changed_files if p]
        out: list[dict[str, Any]] = []
        seen: set[str] = set()

        for label in await self._labels():
            try:
                rows = await self._graph.query(f'SELECT qualified_name, props FROM "{label}" LIMIT {limit}')
            except Exception:
                rows = []
            for row in rows:
                qn = str(row.get("qualified_name", ""))
                props = _parse_props(row.get("props"))
                source = str(props.get("sourceFile", "")).replace("\\", "/")
                if not qn or not source:
                    continue
                if not self._is_in_scope(qn):
                    continue
                if not any(source.endswith(path) or path.endswith(source) or source.find(path) >= 0 for path in normalized):
                    continue
                if qn in seen:
                    continue
                seen.add(qn)
                out.append(
                    {
                        "qualifiedName": self._descope_qname(qn),
                        "scopedQualifiedName": qn,
                        "label": label,
                        "sourceFile": source,
                        "props": props,
                    }
                )
        return out

    @staticmethod
    def _looks_like_test_name(name: str) -> bool:
        lower = name.lower()
        return lower.endswith("test") or "test" in lower

    async def _all_test_nodes(self, limit: int = 5000) -> list[dict[str, Any]]:
        tests: list[dict[str, Any]] = []
        for label in await self._labels():
            try:
                rows = await self._graph.query(f'SELECT qualified_name, props FROM "{label}" LIMIT {limit}')
            except Exception:
                rows = []
            for row in rows:
                scoped_qn = str(row.get("qualified_name", ""))
                if not scoped_qn or not self._is_in_scope(scoped_qn):
                    continue
                props = _parse_props(row.get("props"))
                unscoped = self._descope_qname(scoped_qn)
                if props.get("isTest") is True or self._looks_like_test_name(unscoped):
                    tests.append(
                        {
                            "qualifiedName": unscoped,
                            "scopedQualifiedName": scoped_qn,
                            "label": label,
                            "props": props,
                        }
                    )
        return tests

    async def _test_gap_intelligence(
        self,
        impacted_components: list[dict[str, Any]],
        max_hops: int = 2,
        max_results_per_component: int = 50,
    ) -> dict[str, Any]:
        all_tests = await self._all_test_nodes()
        all_test_names = sorted({t["qualifiedName"] for t in all_tests})
        coverage_by_component: list[dict[str, Any]] = []
        covered_components = 0

        for component in impacted_components:
            component_name = component["node"]["qualifiedName"]
            if self._looks_like_test_name(component_name):
                continue

            upstream = await self.trace_upstream(
                start_node=component_name,
                max_hops=max_hops,
                max_results=max_results_per_component,
                time_budget_ms=1500,
            )
            direct_tests = sorted(
                {
                    finding["target_node"]
                    for finding in upstream.get("findings", [])
                    if self._looks_like_test_name(finding["target_node"])
                }
            )

            fuzzy_suggested = sorted(
                {
                    test_name
                    for test_name in all_test_names
                    if component_name.lower().split(".")[-1].replace("__c", "")[:12]
                    in test_name.lower()
                }
            )[:10]

            has_coverage = bool(direct_tests or fuzzy_suggested)
            if has_coverage:
                covered_components += 1

            coverage_by_component.append(
                {
                    "component": component_name,
                    "direct_covering_tests": direct_tests,
                    "suggested_tests": fuzzy_suggested,
                    "has_coverage": has_coverage,
                }
            )

        total_components = len([c for c in impacted_components if not self._looks_like_test_name(c["node"]["qualifiedName"])])
        coverage_ratio = (covered_components / total_components) if total_components else 1.0
        uncovered_components = [c["component"] for c in coverage_by_component if not c["has_coverage"]]

        return {
            "total_impacted_components": total_components,
            "covered_components": covered_components,
            "coverage_ratio": round(coverage_ratio, 3),
            "coverage_by_component": coverage_by_component,
            "uncovered_components": uncovered_components,
            "all_known_tests": all_test_names,
        }

    async def impact_from_changed_files(
        self,
        changed_files: list[str],
        max_hops: int = 2,
        max_results_per_component: int = 25,
    ) -> dict[str, Any]:
        """Compute impact report from a list of changed source files."""
        seed_nodes = await self._find_nodes_by_source_files(changed_files)
        impacted_components = []
        all_findings = []
        partial = False

        for node in seed_nodes:
            trace = await self.trace_downstream(
                start_node=node["qualifiedName"],
                max_hops=max_hops,
                max_results=max_results_per_component,
                time_budget_ms=1500,
            )
            partial = partial or trace.get("partial_results", False)
            impacted_components.append(
                {
                    "node": node,
                    "downstream_count": len(trace["findings"]),
                    "trace_limit_hit": trace.get("trace_limit_hit", False),
                }
            )
            all_findings.extend(trace["findings"])

        impacted_tests = sorted(
            {
                item["node"]["qualifiedName"]
                for item in impacted_components
                if item["node"]["qualifiedName"].lower().endswith("test")
                or "test" in item["node"]["qualifiedName"].lower()
            }
        )
        impacted_tests.extend(
            sorted(
                {
                    finding["target_node"]
                    for finding in all_findings
                    if "test" in finding["target_node"].lower()
                }
            )
        )
        impacted_tests = sorted(set(impacted_tests))
        missing_test_areas = sorted(
            {
                f["target_node"]
                for f in all_findings
                if "test" not in f["target_node"].lower()
            }
        )[:50]

        test_intelligence = await self._test_gap_intelligence(
            impacted_components=impacted_components,
            max_hops=max_hops,
            max_results_per_component=max_results_per_component,
        )
        test_gap_areas = [
            {
                "component": comp["component"],
                "suggested_test_targets": comp["suggested_tests"][:5],
            }
            for comp in test_intelligence["coverage_by_component"]
            if not comp["has_coverage"]
        ]

        risk_score = len(seed_nodes) + len(all_findings)
        if risk_score >= 30:
            risk_level = "high"
        elif risk_score >= 10:
            risk_level = "medium"
        else:
            risk_level = "low"

        return {
            "changed_files": changed_files,
            "impacted_components": impacted_components,
            "impacted_findings": all_findings[:500],
            "impacted_tests": impacted_tests,
            "missing_test_areas": missing_test_areas,
            "test_gap_areas": test_gap_areas,
            "test_intelligence": test_intelligence,
            "risk_level": risk_level,
            "risk_score": risk_score,
            "freshness": await self.freshness(partial_results=partial),
            "partial_results": partial,
        }

    async def impact_from_git_diff(
        self,
        base_ref: str = "HEAD~1",
        head_ref: str = "HEAD",
        max_hops: int = 2,
        max_results_per_component: int = 25,
    ) -> dict[str, Any]:
        """Compute impact report from git diff file list."""
        try:
            result = subprocess.run(
                ["git", "diff", "--name-only", f"{base_ref}...{head_ref}"],
                cwd=str(self._repo_root),
                check=True,
                capture_output=True,
                text=True,
            )
            changed_files = [line.strip() for line in result.stdout.splitlines() if line.strip()]
        except Exception:
            changed_files = []

        return await self.impact_from_changed_files(
            changed_files=changed_files,
            max_hops=max_hops,
            max_results_per_component=max_results_per_component,
        )

    async def test_gap_intelligence_from_changed_files(
        self,
        changed_files: list[str],
        max_hops: int = 2,
        max_results_per_component: int = 25,
    ) -> dict[str, Any]:
        impact = await self.impact_from_changed_files(
            changed_files=changed_files,
            max_hops=max_hops,
            max_results_per_component=max_results_per_component,
        )
        return {
            "changed_files": changed_files,
            "risk_level": impact.get("risk_level"),
            "risk_score": impact.get("risk_score"),
            "test_intelligence": impact.get("test_intelligence", {}),
            "freshness": impact.get("freshness"),
            "partial_results": impact.get("partial_results", False),
        }

    async def test_gap_intelligence_from_git_diff(
        self,
        base_ref: str = "HEAD~1",
        head_ref: str = "HEAD",
        max_hops: int = 2,
        max_results_per_component: int = 25,
    ) -> dict[str, Any]:
        try:
            result = subprocess.run(
                ["git", "diff", "--name-only", f"{base_ref}...{head_ref}"],
                cwd=str(self._repo_root),
                check=True,
                capture_output=True,
                text=True,
            )
            changed_files = [line.strip() for line in result.stdout.splitlines() if line.strip()]
        except Exception:
            changed_files = []
        return await self.test_gap_intelligence_from_changed_files(
            changed_files=changed_files,
            max_hops=max_hops,
            max_results_per_component=max_results_per_component,
        )
