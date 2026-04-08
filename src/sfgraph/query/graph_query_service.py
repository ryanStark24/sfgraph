"""Graph query and lineage service with evidence-first outputs."""
from __future__ import annotations

import json
import os
import re
import subprocess
import time
from collections import deque
from pathlib import Path
from typing import Any

from sfgraph.common import parse_json_props
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

    _SKIP_DIR_NAMES = frozenset({".git", ".hg", ".svn", "node_modules", ".sf", ".sfdx", ".venv", "venv", "__pycache__"})
    _EXACT_SEARCH_SUFFIXES = (
        ".cls",
        ".trigger",
        ".flow-meta.xml",
        ".object-meta.xml",
        ".labels-meta.xml",
        ".label-meta.xml",
        ".json",
        ".xml",
    )

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

        # Fast path via DuckPGQ node index (when available).
        indexed_labels: list[str] = []
        for candidate_qname in (scoped_qname, qualified_name):
            try:
                idx_rows = await self._graph.query(
                    "SELECT label FROM _sfgraph_node_index WHERE qualified_name = $qn LIMIT 1",
                    {"qn": candidate_qname},
                )
            except Exception:
                idx_rows = []
            if idx_rows:
                label = str(idx_rows[0].get("label", ""))
                if label:
                    indexed_labels.append(label)
        label_order = indexed_labels + [label for label in await self._labels() if label not in indexed_labels]
        for label in label_order:
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
                    props = parse_json_props(row.get("props"))
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
            props = parse_json_props(rows[0].get("props"))
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
        used_unified_view = False
        try:
            if direction == "out":
                unified_rows = await self._graph.query(
                    "SELECT src_qualified_name, dst_qualified_name, props, rel_type "
                    "FROM _sfgraph_all_edges WHERE src_qualified_name = $qn",
                    {"qn": scoped_qname},
                )
            else:
                unified_rows = await self._graph.query(
                    "SELECT src_qualified_name, dst_qualified_name, props, rel_type "
                    "FROM _sfgraph_all_edges WHERE dst_qualified_name = $qn",
                    {"qn": scoped_qname},
                )
            used_unified_view = True
        except Exception:
            unified_rows = []

        def _append_edge_row(row: dict[str, Any], rel: str) -> None:
            src_scoped = str(row.get("src_qualified_name", ""))
            dst_scoped = str(row.get("dst_qualified_name", ""))
            if not src_scoped or not dst_scoped:
                return
            if not self._is_in_scope(src_scoped) or not self._is_in_scope(dst_scoped):
                return
            props = parse_json_props(row.get("props"))
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

        if used_unified_view:
            for row in unified_rows:
                rel = str(row.get("rel_type", ""))
                if not rel:
                    continue
                _append_edge_row(row, rel)
            return rows_out

        # Backward-compatible fallback when unified view is unavailable.
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
                _append_edge_row(row, rel)
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

    def _iter_repo_files(self, suffixes: tuple[str, ...] | None = None):
        suffixes = suffixes or self._EXACT_SEARCH_SUFFIXES
        for current_root, dirs, filenames in os.walk(self._repo_root):
            dirs[:] = [d for d in dirs if d not in self._SKIP_DIR_NAMES]
            for filename in filenames:
                if not filename.endswith(suffixes):
                    continue
                yield Path(current_root) / filename

    @staticmethod
    def _read_text_safe(path: Path) -> str:
        try:
            return path.read_text(encoding="utf-8", errors="ignore")
        except Exception:
            return ""

    @staticmethod
    def _classify_exact_field_match(
        field_token: str,
        line: str,
        window: str,
        file_path: Path,
    ) -> tuple[str, float]:
        lower_line = line.lower()
        lower_window = window.lower()
        if file_path.suffix in {".cls", ".trigger"}:
            assignment_patterns = (
                rf"\b{re.escape(field_token)}\b\s*=",
                rf"\.\s*{re.escape(field_token)}\s*=",
            )
            if any(re.search(pattern, line) for pattern in assignment_patterns):
                return "write", 0.98
            if any(keyword in lower_window for keyword in ("select ", "where ", ".get(", "map<", "jsonattribute", "serviceid")):
                return "read", 0.9
            return "mention", 0.75

        if file_path.suffix == ".json":
            if any(keyword in lower_window for keyword in ("destinationfield", "destinationfields", "targetfield", "updateablefields")):
                return "write", 0.9
            if any(keyword in lower_window for keyword in ("sourcefield", "sourcefields", "input", "query", "extract")):
                return "read", 0.82
            return "mention", 0.7

        if file_path.suffix.endswith(".xml"):
            if any(keyword in lower_window for keyword in ("<field>", "<assigntoreference>", "<outputassignments>", "<recordupdates>")):
                return "write", 0.85
            return "mention", 0.7

        return "mention", 0.65

    @staticmethod
    def _classify_component_token_match(token: str, line: str, window: str, file_path: Path) -> tuple[str, float]:
        lower_line = line.lower()
        lower_window = window.lower()
        escaped = re.escape(token)
        if file_path.suffix in {".cls", ".trigger"}:
            write_patterns = (
                rf"\b{escaped}\b\s*=",
                rf"\.put\(\s*['\"]{escaped}['\"]\s*,",
                rf"['\"]{escaped}['\"]\s*:",
            )
            read_patterns = (
                rf"\b{escaped}\b",
                rf"\.get\(\s*['\"]{escaped}['\"]\s*\)",
            )
            if any(re.search(pattern, line) for pattern in write_patterns):
                return "write", 0.98
            if any(re.search(pattern, line) for pattern in read_patterns):
                if "put(" in lower_window or "= " in lower_window:
                    return "read", 0.9
                return "mention", 0.75
            return "mention", 0.7
        if file_path.suffix == ".json":
            if any(keyword in lower_window for keyword in ("put(", "destinationfield", "destinationfields", "output", "setvalues")):
                return "write", 0.88
            if any(keyword in lower_window for keyword in ("sourcefield", "input", "get(", "extract", "query")):
                return "read", 0.82
            return "mention", 0.7
        if file_path.suffix.endswith(".xml"):
            if any(keyword in lower_window for keyword in ("<assigntoreference>", "<recordupdates>", "<outputassignments>")):
                return "write", 0.84
            return "mention", 0.7
        return "mention", 0.65

    async def _find_component_nodes(self, component_name: str, max_results: int = 20) -> list[dict[str, Any]]:
        search = component_name.strip()
        if not search:
            return []
        normalized_search = self._rules.resolve_alias(search)
        out: list[dict[str, Any]] = []
        seen: set[str] = set()
        for label in await self._labels():
            try:
                rows = await self._graph.query(
                    f'SELECT qualified_name, props FROM "{label}" WHERE lower(qualified_name) LIKE $needle LIMIT 200',
                    {"needle": f"%{normalized_search.lower()}%"},
                )
            except Exception:
                rows = []
            for row in rows:
                scoped_qname = str(row.get("qualified_name", ""))
                if not scoped_qname or scoped_qname in seen or not self._is_in_scope(scoped_qname):
                    continue
                descoped = self._descope_qname(scoped_qname)
                if descoped != normalized_search and not descoped.endswith(f".{normalized_search}") and normalized_search.lower() not in descoped.lower():
                    continue
                seen.add(scoped_qname)
                out.append(
                    {
                        "qualifiedName": descoped,
                        "scopedQualifiedName": scoped_qname,
                        "label": label,
                        "props": parse_json_props(row.get("props")),
                    }
                )
                if len(out) >= max_results:
                    return out
        return out

    async def analyze_component(
        self,
        component_name: str,
        token: str | None = None,
        focus: str = "both",
        max_results: int = 100,
    ) -> dict[str, Any]:
        resolved_nodes = await self._find_component_nodes(component_name, max_results=25)
        if not resolved_nodes:
            for source_path in self._find_component_source_files(component_name, max_results=25):
                resolved_nodes.append(
                    {
                        "qualifiedName": component_name.strip(),
                        "scopedQualifiedName": "",
                        "label": "SourceFile",
                        "props": {"sourceFile": str(source_path)},
                    }
                )
        exact_matches: list[dict[str, Any]] = []
        graph_relations: list[dict[str, Any]] = []
        seen_exact: set[tuple[str, int, str]] = set()
        seen_sources: set[str] = set()

        for node in resolved_nodes:
            qname = node["qualifiedName"]
            if node.get("scopedQualifiedName"):
                outgoing = await self._edges_for_node(qname, "out")
                incoming = await self._edges_for_node(qname, "in")
                graph_relations.append(
                    {
                        "node": qname,
                        "outgoing": outgoing[:25],
                        "incoming": incoming[:25],
                    }
                )

            source_file = str(node.get("props", {}).get("sourceFile", ""))
            if not source_file:
                continue
            source_path = Path(source_file)
            if not source_path.is_absolute():
                source_path = (self._repo_root / source_path).resolve()
            source_key = str(source_path)
            if source_key in seen_sources:
                continue
            seen_sources.add(source_key)
            text = self._read_text_safe(source_path)
            if not text:
                continue
            if token and token not in text:
                continue
            lines = text.splitlines()
            if token:
                token_matcher = token
            else:
                token_matcher = component_name
            for idx, line in enumerate(lines, start=1):
                if token_matcher not in line:
                    continue
                start = max(0, idx - 3)
                end = min(len(lines), idx + 2)
                window = "\n".join(lines[start:end])
                kind, confidence = self._classify_component_token_match(token_matcher, line, window, source_path)
                if focus == "writes" and kind != "write":
                    continue
                if focus == "reads" and kind not in {"read", "write"}:
                    continue
                key = (str(source_path), idx, kind)
                if key in seen_exact:
                    continue
                seen_exact.add(key)
                exact_matches.append(
                    {
                        "component": qname,
                        "token": token_matcher,
                        "kind": kind,
                        "file": str(source_path),
                        "line": idx,
                        "context": line.strip()[:240],
                        "confidence": confidence,
                    }
                )

        exact_matches.sort(key=lambda item: (0 if item["kind"] == "write" else 1, -float(item["confidence"])))
        partial = len(exact_matches) > max_results or len(graph_relations) > max_results
        return {
            "mode": "analyze_component",
            "component_query": component_name,
            "resolved_components": resolved_nodes[:max_results],
            "token": token,
            "focus": focus,
            "exact_matches": exact_matches[:max_results],
            "graph_relations": graph_relations[:max_results],
            "freshness": await self.freshness(partial_results=partial),
            "partial_results": partial,
            "coverage_note": (
                "Exact source matches are prioritized for token-level tracing. "
                "Graph relations provide neighboring context for impact and lineage."
            ),
        }

    def _find_component_source_files(self, component_name: str, max_results: int = 20) -> list[Path]:
        name = component_name.strip()
        if not name:
            return []
        out: list[Path] = []
        seen: set[str] = set()

        def _add(path: Path) -> None:
            resolved = path.resolve()
            key = str(resolved)
            if not resolved.exists() or key in seen:
                return
            seen.add(key)
            out.append(resolved)

        package_metadata_roots = self._package_metadata_roots()
        exact_roots: list[Path] = []
        for metadata_root in package_metadata_roots:
            exact_roots.append(metadata_root / "classes")
            exact_roots.append(metadata_root / "triggers")
        exact_roots.append(self._repo_root / "vlocity")

        for suffix in (".cls", ".trigger", ".js", ".ts", ".xml", ".json"):
            for root in exact_roots:
                _add(root / f"{name}{suffix}")
            if len(out) >= max_results:
                return out[:max_results]

        class_pattern = re.compile(rf"\b(?:class|trigger)\s+{re.escape(name)}\b", re.IGNORECASE)
        search_roots = exact_roots
        allowed_exts = {".cls", ".trigger", ".js", ".ts", ".xml", ".json"}
        for root in search_roots:
            if not root.exists():
                continue
            for path in root.rglob("*"):
                if not path.is_file() or path.suffix.lower() not in allowed_exts:
                    continue
                text = self._read_text_safe(path)
                if not text:
                    continue
                if class_pattern.search(text) or name in text:
                    _add(path)
                    if len(out) >= max_results:
                        return out[:max_results]
        return out[:max_results]

    def _package_metadata_roots(self) -> list[Path]:
        candidates = self._sfdx_package_directories()
        if not candidates:
            candidates = [self._repo_root / "force-app"]
        roots: list[Path] = []
        seen: set[str] = set()
        for package_dir in candidates:
            metadata_root = package_dir / "main" / "default"
            if not metadata_root.exists():
                metadata_root = package_dir
            resolved = metadata_root.resolve()
            key = str(resolved)
            if not resolved.exists() or key in seen:
                continue
            seen.add(key)
            roots.append(resolved)
        return roots

    def _sfdx_package_directories(self) -> list[Path]:
        config_path = self._repo_root / "sfdx-project.json"
        if not config_path.exists():
            return []
        try:
            payload = json.loads(config_path.read_text(encoding="utf-8"))
        except Exception:
            return []
        package_dirs = payload.get("packageDirectories")
        if not isinstance(package_dirs, list):
            return []
        out: list[Path] = []
        seen: set[str] = set()
        for entry in package_dirs:
            if not isinstance(entry, dict):
                continue
            rel_path = entry.get("path")
            if not isinstance(rel_path, str) or not rel_path.strip():
                continue
            candidate = (self._repo_root / rel_path).expanduser().resolve()
            key = str(candidate)
            if not candidate.exists() or not candidate.is_dir() or key in seen:
                continue
            seen.add(key)
            out.append(candidate)
        return out

    @staticmethod
    def _component_token_query_parts(question: str) -> tuple[str, str] | None:
        q = " ".join(question.strip().split())
        patterns = (
            (
                r"\bin\s+class\s+([A-Za-z_][A-Za-z0-9_]*)\s*,?\s*where\s+([A-Za-z_][A-Za-z0-9_]*)\s+(?:is\s+)?(?:populated|set|assigned|updated)\b",
                ("component", "token"),
            ),
            (
                r"\bin\s+class\s+([A-Za-z_][A-Za-z0-9_]*)\s*,?\s*where\s+is\s+([A-Za-z_][A-Za-z0-9_]*)\s+(?:being\s+)?(?:populated|set|assigned|updated)\b",
                ("component", "token"),
            ),
            (
                r"\bwhere\s+is\s+([A-Za-z_][A-Za-z0-9_]*)\s+(?:being\s+)?(?:populated|set|assigned|updated)\s+in\s+class\s+([A-Za-z_][A-Za-z0-9_]*)\b",
                ("token", "component"),
            ),
            (
                r"\bin\s+([A-Za-z_][A-Za-z0-9_]*)\s*,?\s*where\s+is\s+([A-Za-z_][A-Za-z0-9_]*)\s+(?:being\s+)?(?:populated|set|assigned|updated)\b",
                ("component", "token"),
            ),
        )
        for pattern, order in patterns:
            match = re.search(pattern, q, flags=re.IGNORECASE)
            if not match:
                continue
            if order == ("token", "component"):
                token = match.group(1)
                component = match.group(2)
            else:
                component = match.group(1)
                token = match.group(2)
            return component, token
        return None

    @staticmethod
    def _object_event_query_parts(question: str) -> tuple[str, str] | None:
        q = " ".join(question.strip().split())
        patterns = (
            r"\bwhat\s+happens\s+when\s+(?:a|an)?\s*([A-Za-z_][A-Za-z0-9_]*)\s+is\s+(inserted|updated|deleted|undeleted)\b",
            r"\b(?:on|for)\s+([A-Za-z_][A-Za-z0-9_]*)\s+(insert|update|delete|undelete)\b",
        )
        for pattern in patterns:
            match = re.search(pattern, q, flags=re.IGNORECASE)
            if not match:
                continue
            object_name = match.group(1)
            event = match.group(2).lower()
            if event.endswith("ed"):
                event = event[:-2]
            return object_name, event
        return None

    @staticmethod
    def _change_query_target(question: str) -> str | None:
        q = " ".join(question.strip().split())
        patterns = (
            r"\bwhat\s+breaks\s+if\s+i\s+change\s+(.+)$",
            r"\bimpact\s+of\s+changing\s+(.+)$",
            r"\bimpact\s+if\s+i\s+change\s+(.+)$",
            r"\bwhat\s+is\s+impacted\s+by\s+(.+)$",
        )
        for pattern in patterns:
            match = re.search(pattern, q, flags=re.IGNORECASE)
            if not match:
                continue
            target = match.group(1).strip().strip("?.")
            if target:
                return target
        return None

    async def analyze_change(
        self,
        target: str | None = None,
        changed_files: list[str] | None = None,
        max_hops: int = 2,
        max_results_per_component: int = 25,
    ) -> dict[str, Any]:
        files: list[str] = []
        target_resolution: dict[str, Any] = {"target": target, "mode": None}

        if changed_files:
            files = [str(Path(item)) for item in changed_files if str(item).strip()]
            target_resolution["mode"] = "explicit_files"
        elif target:
            target_clean = target.strip()
            if "/" in target_clean or target_clean.endswith((".cls", ".trigger", ".xml", ".json")):
                file_path = Path(target_clean)
                if not file_path.is_absolute():
                    file_path = (self._repo_root / file_path).resolve()
                files = [str(file_path)]
                target_resolution["mode"] = "file_target"
            else:
                nodes = await self._find_component_nodes(target_clean, max_results=10)
                resolved_files: list[str] = []
                for node in nodes:
                    source_file = str(node.get("props", {}).get("sourceFile", ""))
                    if not source_file:
                        continue
                    source_path = Path(source_file)
                    if not source_path.is_absolute():
                        source_path = (self._repo_root / source_path).resolve()
                    resolved_files.append(str(source_path))
                files = sorted(set(resolved_files))
                target_resolution["mode"] = "component_target"
                target_resolution["resolved_components"] = [node["qualifiedName"] for node in nodes]
        else:
            files = []
            target_resolution["mode"] = "none"

        impact = await self.impact_from_changed_files(
            changed_files=files,
            max_hops=max_hops,
            max_results_per_component=max_results_per_component,
        )
        return {
            "mode": "analyze_change",
            "target_resolution": target_resolution,
            "analysis": impact,
            "freshness": impact.get("freshness"),
            "partial_results": impact.get("partial_results", False),
        }

    async def analyze_field(self, field_name: str, focus: str = "both", max_results: int = 100) -> dict[str, Any]:
        resolved_fields = await self._field_targets_for_question(field_name)
        if not resolved_fields:
            resolved_fields = [self._rules.resolve_alias(field_name)]

        findings: list[dict[str, Any]] = []
        repo_results: list[dict[str, Any]] = []
        seen_keys: set[tuple[str, str, int, str]] = set()

        for resolved in resolved_fields:
            explain = await self.explain_field(resolved)
            graph_findings = []
            if focus in {"both", "writes"}:
                graph_findings.extend({"field": resolved, "source": "graph", "kind": "write", **item} for item in explain.get("writers", []))
            if focus in {"both", "reads"}:
                graph_findings.extend({"field": resolved, "source": "graph", "kind": "read", **item} for item in explain.get("readers", []))
            findings.extend(graph_findings)

            token = resolved.split(".", 1)[1] if "." in resolved else resolved
            for path in self._iter_repo_files():
                text = self._read_text_safe(path)
                if token not in text and resolved not in text:
                    continue
                lines = text.splitlines()
                for idx, line in enumerate(lines, start=1):
                    if token not in line and resolved not in line:
                        continue
                    start = max(0, idx - 3)
                    end = min(len(lines), idx + 2)
                    window = "\n".join(lines[start:end])
                    kind, confidence = self._classify_exact_field_match(token, line, window, path)
                    if focus == "writes" and kind != "write":
                        continue
                    if focus == "reads" and kind not in {"read", "write"}:
                        continue
                    key = (str(path), resolved, idx, kind)
                    if key in seen_keys:
                        continue
                    seen_keys.add(key)
                    repo_results.append(
                        {
                            "field": resolved,
                            "source": "repo_search",
                            "kind": kind,
                            "file": str(path),
                            "line": idx,
                            "context": line.strip()[:240],
                            "confidence": confidence,
                        }
                    )

        repo_results.sort(key=lambda item: (0 if item["kind"] == "write" else 1, -float(item["confidence"])))
        findings.sort(key=lambda item: -float(item.get("confidence", 0.0)))
        partial = len(repo_results) > max_results or len(findings) > max_results
        return {
            "mode": "analyze_field",
            "field_query": field_name,
            "resolved_fields": resolved_fields,
            "focus": focus,
            "graph_findings": findings[:max_results],
            "exact_matches": repo_results[:max_results],
            "freshness": await self.freshness(partial_results=partial),
            "partial_results": partial,
            "coverage_note": (
                "Exact repo evidence and graph evidence are both included. "
                "When graph coverage is incomplete, exact repo matches may reveal additional writers/readers."
            ),
        }

    @staticmethod
    def _parse_trigger_declaration(text: str) -> tuple[str, str, set[str]] | None:
        match = re.search(r"trigger\s+([A-Za-z_][A-Za-z0-9_]*)\s+on\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(([^)]*)\)", text, re.IGNORECASE | re.DOTALL)
        if not match:
            return None
        trigger_name = match.group(1)
        object_name = match.group(2)
        events = {
            event.strip().lower()
            for event in match.group(3).split(",")
            if event.strip()
        }
        return trigger_name, object_name, events

    @staticmethod
    def _extract_method_calls(text: str) -> list[dict[str, str]]:
        calls: list[dict[str, str]] = []
        seen: set[tuple[str, str]] = set()
        for match in re.finditer(r"\b([A-Za-z_][A-Za-z0-9_]*)\.([A-Za-z_][A-Za-z0-9_]*)\s*\(", text):
            klass = match.group(1)
            method = match.group(2)
            key = (klass, method)
            if key in seen:
                continue
            seen.add(key)
            calls.append({"className": klass, "methodName": method})
        return calls

    async def analyze_object_event(self, object_name: str, event: str, max_results: int = 50) -> dict[str, Any]:
        target_event = event.strip().lower()
        matched_triggers: list[dict[str, Any]] = []
        for path in self._iter_repo_files((".trigger",)):
            text = self._read_text_safe(path)
            parsed = self._parse_trigger_declaration(text)
            if not parsed:
                continue
            trigger_name, trigger_object, events = parsed
            if trigger_object.lower() != object_name.lower():
                continue
            if target_event not in events and f"before {target_event}" not in events and f"after {target_event}" not in events:
                continue
            phases = sorted(e for e in events if e.endswith(target_event))
            matched_triggers.append(
                {
                    "triggerName": trigger_name,
                    "objectName": trigger_object,
                    "events": sorted(events),
                    "matchingPhases": phases or [target_event],
                    "file": str(path),
                    "methodCalls": self._extract_method_calls(text),
                }
            )

        phase_map: dict[str, list[dict[str, Any]]] = {}
        for trigger in matched_triggers:
            for phase in trigger["matchingPhases"]:
                phase_map.setdefault(phase, []).append(trigger)

        findings: list[dict[str, Any]] = []
        for phase, triggers in sorted(phase_map.items()):
            for trigger in triggers:
                findings.append(
                    {
                        "phase": phase,
                        "triggerName": trigger["triggerName"],
                        "file": trigger["file"],
                        "methodCalls": trigger["methodCalls"][:20],
                    }
                )

        return {
            "mode": "analyze_object_event",
            "object_name": object_name,
            "event": target_event,
            "triggers": matched_triggers[:max_results],
            "phases": phase_map,
            "findings": findings[:max_results],
            "freshness": await self.freshness(partial_results=len(matched_triggers) > max_results),
            "partial_results": len(matched_triggers) > max_results,
            "important_note": (
                "Salesforce does not guarantee execution order across multiple triggers on the same object event. "
                "All matched triggers run in the same transaction."
            ),
        }

    async def query(
        self,
        question: str,
        max_hops: int = 3,
        max_results: int = 50,
        time_budget_ms: int = 1500,
        offset: int = 0,
        allow_vector_fallback: bool = True,
    ) -> dict[str, Any]:
        q = question.strip()
        change_target = self._change_query_target(q)
        if change_target:
            result = await self.analyze_change(target=change_target, max_hops=max_hops, max_results_per_component=max_results)
            result["question"] = q
            result["pipeline"] = {
                "intent": "analyze_change",
                "hint": "Change-impact query routed to impact analysis.",
            }
            return result

        object_event = self._object_event_query_parts(q)
        if object_event:
            object_name, event = object_event
            result = await self.analyze_object_event(
                object_name=object_name,
                event=event,
                max_results=max_results,
            )
            result["question"] = q
            result["pipeline"] = {
                "intent": "object_event",
                "hint": "Object lifecycle query routed to trigger/event analysis.",
            }
            return result

        component_token = self._component_token_query_parts(q)
        if component_token:
            component_name, token = component_token
            result = await self.analyze_component(
                component_name=component_name,
                token=token,
                focus="writes",
                max_results=max_results,
            )
            result["question"] = q
            result["pipeline"] = {
                "intent": "component_token_writes",
                "hint": "Exact component token tracing; semantic vector fallback disabled.",
            }
            result["confidence_tiers"] = self._confidence_tiers(result.get("exact_matches", []))
            return result

        schema_filter, schema_trace = await self._schema_filter(q)
        intent = self._intent(q)
        planner_trace = self._planner_agent.run(question=q, intent=intent)
        field_targets = await self._field_targets_for_question(q)
        field_match = field_targets[0] if field_targets else None
        field_query_mode = self._field_query_mode(q)

        if field_query_mode and field_targets:
            result = await self._query_field_access(
                question=q,
                field_targets=field_targets,
                focus=field_query_mode,
                max_results=max_results,
                schema_filter=schema_filter,
                schema_trace=schema_trace,
                planner_trace=planner_trace,
            )
            return result

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
        if not candidates and allow_vector_fallback:
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
                else (
                    "No lexical candidates and vector fallback disabled."
                    if not allow_vector_fallback
                    else "Lexical label-filtered search succeeded."
                ),
            },
            "freshness": await self.freshness(partial_results=partial),
            "partial_results": partial,
        }

    @staticmethod
    def _collect_analyze_evidence(result: dict[str, Any], max_items: int = 50) -> list[dict[str, Any]]:
        evidence: list[dict[str, Any]] = []

        for item in result.get("exact_matches", [])[:max_items]:
            evidence.append(
                {
                    "source": "exact",
                    "kind": item.get("kind", "mention"),
                    "confidence": float(item.get("confidence", 0.7)),
                    "file": item.get("file"),
                    "line": item.get("line"),
                    "context": item.get("context"),
                }
            )

        for item in result.get("graph_findings", [])[:max_items]:
            path = item.get("path", [])
            step = path[-1] if path else {}
            evidence.append(
                {
                    "source": "graph",
                    "kind": item.get("kind", "relation"),
                    "confidence": float(item.get("confidence", 0.6)),
                    "file": step.get("source_file"),
                    "line": step.get("source_line"),
                    "context": step.get("contextSnippet"),
                    "rel_type": step.get("rel_type"),
                }
            )

        for item in result.get("findings", [])[:max_items]:
            path = item.get("path", [])
            step = path[-1] if path else {}
            evidence.append(
                {
                    "source": "graph",
                    "kind": "path",
                    "confidence": float(item.get("confidence", 0.6)),
                    "file": step.get("source_file"),
                    "line": step.get("source_line"),
                    "context": step.get("contextSnippet"),
                    "rel_type": step.get("rel_type"),
                }
            )

        return evidence[:max_items]

    async def analyze(
        self,
        question: str,
        mode: str = "auto",
        strict: bool = True,
        max_results: int = 50,
        max_hops: int = 3,
        time_budget_ms: int = 1500,
        offset: int = 0,
    ) -> dict[str, Any]:
        q = question.strip()
        selected_mode = (mode or "auto").strip().lower()
        if selected_mode not in {"auto", "exact", "lineage"}:
            raise ValueError("mode must be one of: auto, exact, lineage")

        routed_to = "query"
        result: dict[str, Any]

        if selected_mode == "exact":
            component_token = self._component_token_query_parts(q)
            if component_token:
                component_name, token = component_token
                routed_to = "analyze_component"
                result = await self.analyze_component(
                    component_name=component_name,
                    token=token,
                    focus="writes" if strict else "both",
                    max_results=max_results,
                )
            else:
                field_targets = await self._field_targets_for_question(q)
                if field_targets:
                    field_mode = self._field_query_mode(q)
                    focus = "writes" if strict and field_mode in {"writes", "explain"} else (field_mode or "both")
                    routed_to = "analyze_field"
                    result = await self.analyze_field(
                        field_name=q,
                        focus=focus,
                        max_results=max_results,
                    )
                else:
                    routed_to = "query"
                    result = await self.query(
                        question=q,
                        max_hops=max_hops,
                        max_results=max_results,
                        time_budget_ms=time_budget_ms,
                        offset=offset,
                        allow_vector_fallback=not strict,
                    )
        elif selected_mode == "lineage":
            object_event = self._object_event_query_parts(q)
            if object_event:
                object_name, event = object_event
                routed_to = "analyze_object_event"
                result = await self.analyze_object_event(
                    object_name=object_name,
                    event=event,
                    max_results=max_results,
                )
            else:
                change_target = self._change_query_target(q)
                if change_target:
                    routed_to = "analyze_change"
                    result = await self.analyze_change(
                        target=change_target,
                        max_hops=max_hops,
                        max_results_per_component=max_results,
                    )
                else:
                    routed_to = "query"
                    result = await self.query(
                        question=q,
                        max_hops=max_hops,
                        max_results=max_results,
                        time_budget_ms=time_budget_ms,
                        offset=offset,
                        allow_vector_fallback=not strict,
                    )
        else:
            result = await self.query(
                question=q,
                max_hops=max_hops,
                max_results=max_results,
                time_budget_ms=time_budget_ms,
                offset=offset,
                allow_vector_fallback=not strict,
            )

        evidence = self._collect_analyze_evidence(result, max_items=max_results)
        if "confidence_tiers" in result:
            confidence_tiers = result["confidence_tiers"]
        else:
            confidence_tiers = self._confidence_tiers(evidence)

        return {
            "mode": "analyze",
            "question": q,
            "analysis_mode": selected_mode,
            "strict": strict,
            "routed_to": routed_to,
            "result": result,
            "evidence": evidence,
            "confidence_tiers": confidence_tiers,
            "freshness": result.get("freshness", await self.freshness(partial_results=False)),
            "partial_results": bool(result.get("partial_results", False)),
        }

    @staticmethod
    def _field_query_mode(question: str) -> str | None:
        q = question.lower()
        if any(phrase in q for phrase in ("what uses", "who uses", "used by")):
            return None
        write_hits = any(
            phrase in q
            for phrase in (
                " populate",
                " populated",
                " populated?",
                " writes ",
                " write ",
                " written",
                " assigned",
                " assign ",
                " set ",
                " sets ",
                " updated",
                " update ",
                " filled",
                " fills ",
            )
        )
        read_hits = any(
            phrase in q
            for phrase in (
                " uses ",
                " use ",
                " used ",
                " read ",
                " reads ",
                " referenced",
                " reference ",
                " consumed",
                " depends on",
            )
        ) or "what uses" in q or "who uses" in q or "used by" in q
        if write_hits and read_hits:
            return "explain"
        if write_hits:
            return "writes"
        if read_hits:
            return "reads"
        return None

    async def _field_targets_for_question(self, question: str, limit: int = 20) -> list[str]:
        explicit_matches = [
            self._rules.resolve_alias(match.group(1))
            for match in re.finditer(r"\b([A-Za-z][A-Za-z0-9_]*\.[A-Za-z][A-Za-z0-9_]*(?:__[A-Za-z0-9_]+)?)\b", question)
        ]
        if explicit_matches:
            return list(dict.fromkeys(explicit_matches))

        bare_matches = [
            self._rules.resolve_alias(match.group(1))
            for match in re.finditer(r"\b([A-Za-z][A-Za-z0-9_]*__(?:c|r|mdt|e))\b", question)
        ]
        targets: list[str] = []
        for token in bare_matches:
            targets.extend(await self._find_fields_by_suffix(token, limit=limit))
            if len(targets) >= limit:
                break
        return list(dict.fromkeys(targets))[:limit]

    async def _find_fields_by_suffix(self, field_token: str, limit: int = 20) -> list[str]:
        scoped_matches: list[str] = []
        try:
            rows = await self._graph.query(
                'SELECT qualified_name, props FROM "SFField" WHERE lower(qualified_name) LIKE $needle LIMIT 200',
                {"needle": f"%.{field_token.lower()}"},
            )
        except Exception:
            rows = []
        for row in rows:
            scoped_qname = str(row.get("qualified_name", ""))
            if not scoped_qname or not self._is_in_scope(scoped_qname):
                continue
            descoped = self._descope_qname(scoped_qname)
            if not descoped.lower().endswith(f".{field_token.lower()}"):
                continue
            scoped_matches.append(descoped)
            if len(scoped_matches) >= limit:
                break
        return scoped_matches

    async def _query_field_access(
        self,
        *,
        question: str,
        field_targets: list[str],
        focus: str,
        max_results: int,
        schema_filter: dict[str, list[str]],
        schema_trace: dict[str, str],
        planner_trace: Any,
    ) -> dict[str, Any]:
        results: list[dict[str, Any]] = []
        aggregated_findings: list[dict[str, Any]] = []
        partial = False
        for field_name in field_targets[:10]:
            payload = await self.explain_field(field_name)
            partial = partial or bool(payload.get("partial_results"))
            field_result = {
                "field": field_name,
                "readers": payload.get("readers", []),
                "writers": payload.get("writers", []),
                "dependents": payload.get("dependents", []),
                "partial_results": bool(payload.get("partial_results")),
            }
            results.append(field_result)
            selected = (
                field_result["writers"]
                if focus == "writes"
                else field_result["readers"]
                if focus == "reads"
                else field_result["writers"] + field_result["readers"]
            )
            for finding in selected:
                aggregated_findings.append({"field": field_name, **finding})

        aggregated_findings.sort(key=lambda finding: float(finding.get("confidence", 0.0)), reverse=True)
        formatter_trace = self._formatter_agent.run(len(aggregated_findings[:max_results]))
        mode = {
            "writes": "field_writes",
            "reads": "field_reads",
            "explain": "field_access",
        }[focus]
        payload: dict[str, Any] = {
            "mode": mode,
            "question": question,
            "fields": results,
            "findings": aggregated_findings[:max_results],
            "partial_results": partial or len(aggregated_findings) > max_results,
            "freshness": await self.freshness(partial_results=partial or len(aggregated_findings) > max_results),
            "confidence_tiers": self._confidence_tiers(aggregated_findings[:max_results]),
            "pipeline": {
                "schema_filter": schema_filter,
                "intent": mode,
                "attempts": [],
                "agent_trace": [
                    schema_trace,
                    {"name": planner_trace.name, "strategy": planner_trace.strategy, "detail": planner_trace.detail},
                    {"name": formatter_trace.name, "strategy": formatter_trace.strategy, "detail": formatter_trace.detail},
                ],
                "hint": "Strict exact field graph search; semantic vector fallback disabled.",
            },
        }
        return payload

    @staticmethod
    def _layer_for_label(label: str) -> str:
        if label in {"LWCComponent", "LWCProperty"}:
            return "UI"
        if label in {"Flow", "FlowElement", "OmniScript"}:
            return "FLOW"
        if label in {"IntegrationProcedure", "IPElement", "IPVariable", "DataRaptor", "VlocityDataPack"}:
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
                        "props": parse_json_props(row.get("props")),
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
        try:
            rows = await self._graph.query(
                "SELECT src_qualified_name, dst_qualified_name, props, rel_type FROM _sfgraph_all_edges"
            )
            source_is_unified_view = True
        except Exception:
            rows = []
            source_is_unified_view = False

        if source_is_unified_view:
            for row in rows:
                props = parse_json_props(row.get("props"))
                resolution_method = str(props.get("resolutionMethod", "unknown"))
                src = str(row.get("src_qualified_name", ""))
                dst = str(row.get("dst_qualified_name", ""))
                rel = str(row.get("rel_type", ""))
                if not src or not dst or not rel:
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
        else:
            for rel in await self._rel_types():
                try:
                    rel_rows = await self._graph.query(
                        f'SELECT src_qualified_name, dst_qualified_name, props FROM "{rel}"'
                    )
                except Exception:
                    rel_rows = []

                for row in rel_rows:
                    props = parse_json_props(row.get("props"))
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
                props = parse_json_props(row.get("props"))
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
                props = parse_json_props(row.get("props"))
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
