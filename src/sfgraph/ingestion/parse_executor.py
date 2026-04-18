"""Parse execution helpers for ingestion."""
from __future__ import annotations

import asyncio
from pathlib import Path
from typing import Any, Awaitable, Callable

from sfgraph.ingestion.models import EdgeFact, NodeFact
from sfgraph.ingestion.parser_dispatch import AURA_MARKUP_SUFFIXES, parser_name_for_file
from sfgraph.parser.aura_parser import parse_aura_file
from sfgraph.parser.flow_parser import parse_flow_xml
from sfgraph.parser.lwc_parser import parse_lwc_file
from sfgraph.parser.metadata_parser import (
    parse_dashboard_xml,
    parse_named_credential_xml,
    parse_permission_metadata_xml,
    parse_report_xml,
    parse_workflow_xml,
)
from sfgraph.parser.object_parser import (
    parse_custom_metadata_record_xml,
    parse_global_value_set_xml,
    parse_labels_xml,
    parse_object_dir,
)
from sfgraph.parser.vlocity_parser import is_vlocity_datapack_file, parse_vlocity_json_detailed

TRANSIENT_WORKER_ERRORS = frozenset({"worker_restarting", "worker_exited", "timeout", "no_workers"})


class ParseExecutor:
    """Execute parser-specific logic with cache hooks and parser dependencies."""

    def __init__(
        self,
        *,
        pool: Any,
        apex_extractor: Any,
        dynamic_registry: Any,
        parse_cache: Any,
        vlocity_rule_bundle: Any,
        cacheable_parser: Callable[[str], bool],
        parse_cache_namespace: Callable[[str, str], str],
        serialize_parse_result: Callable[[list[NodeFact], list[EdgeFact], dict[str, Any] | None], dict[str, Any]],
        deserialize_parse_result: Callable[[dict[str, Any]], tuple[list[NodeFact], list[EdgeFact], dict[str, Any]]],
        rebind_cached_nodes: Callable[[list[NodeFact], str], list[NodeFact]],
        format_parser_failure_details: Callable[[Any], str],
    ) -> None:
        self._pool = pool
        self._apex_extractor = apex_extractor
        self._dynamic_registry = dynamic_registry
        self._parse_cache = parse_cache
        self._vlocity_rule_bundle = vlocity_rule_bundle
        self._cacheable_parser = cacheable_parser
        self._parse_cache_namespace = parse_cache_namespace
        self._serialize_parse_result = serialize_parse_result
        self._deserialize_parse_result = deserialize_parse_result
        self._rebind_cached_nodes = rebind_cached_nodes
        self._format_parser_failure_details = format_parser_failure_details

    async def execute(self, fpath: str, *, sha256: str | None = None) -> tuple[list[NodeFact], list[EdgeFact], dict[str, Any]]:
        path = Path(fpath)
        parser_name = parser_name_for_file(path)
        cache_namespace = self._parse_cache_namespace(parser_name, fpath)
        can_cache = self._cacheable_parser(parser_name)
        if self._parse_cache and sha256 and can_cache:
            cached = await self._parse_cache.get(cache_namespace, sha256)
            if cached is not None:
                nodes, edges, metadata = self._deserialize_parse_result(cached)
                return self._rebind_cached_nodes(nodes, fpath), edges, metadata

        if path.suffix in {".cls", ".trigger"}:
            return await self._parse_apex_file(fpath, path, sha256=sha256, cache_namespace=cache_namespace, can_cache=can_cache)

        if path.suffix in {".js", ".html"} and "lwc" in {part.lower() for part in path.parts}:
            return await self._execute_simple_parse(
                fpath,
                sha256=sha256,
                cache_namespace=cache_namespace,
                can_cache=can_cache,
                parser=lambda: parse_lwc_file(fpath),
            )

        if path.suffix in AURA_MARKUP_SUFFIXES and "aura" in {part.lower() for part in path.parts}:
            return await self._execute_simple_parse(
                fpath,
                sha256=sha256,
                cache_namespace=cache_namespace,
                can_cache=can_cache,
                parser=lambda: parse_aura_file(fpath),
            )

        if fpath.endswith(".flow-meta.xml"):
            return await self._execute_simple_parse(
                fpath,
                sha256=sha256,
                cache_namespace=cache_namespace,
                can_cache=can_cache,
                parser=lambda: parse_flow_xml(fpath),
            )

        if fpath.endswith(".object-meta.xml"):
            return await self._execute_simple_parse(
                fpath,
                sha256=sha256,
                cache_namespace=cache_namespace,
                can_cache=can_cache,
                parser=lambda: parse_object_dir(str(path.parent)),
            )

        if fpath.endswith(".globalValueSet-meta.xml"):
            return await self._execute_simple_parse(
                fpath,
                sha256=sha256,
                cache_namespace=cache_namespace,
                can_cache=can_cache,
                parser=lambda: parse_global_value_set_xml(fpath),
            )

        if fpath.endswith(".md-meta.xml"):
            return await self._execute_simple_parse(
                fpath,
                sha256=sha256,
                cache_namespace=cache_namespace,
                can_cache=can_cache,
                parser=lambda: parse_custom_metadata_record_xml(fpath),
            )

        if fpath.endswith(".workflow-meta.xml"):
            return await self._execute_simple_parse(
                fpath,
                sha256=sha256,
                cache_namespace=cache_namespace,
                can_cache=can_cache,
                parser=lambda: parse_workflow_xml(fpath),
            )

        if fpath.endswith(".permissionset-meta.xml") or fpath.endswith(".profile-meta.xml"):
            return await self._execute_simple_parse(
                fpath,
                sha256=sha256,
                cache_namespace=cache_namespace,
                can_cache=can_cache,
                parser=lambda: parse_permission_metadata_xml(fpath),
            )

        if fpath.endswith(".namedCredential-meta.xml"):
            return await self._execute_simple_parse(
                fpath,
                sha256=sha256,
                cache_namespace=cache_namespace,
                can_cache=can_cache,
                parser=lambda: parse_named_credential_xml(fpath),
            )

        if fpath.endswith(".report-meta.xml"):
            return await self._execute_simple_parse(
                fpath,
                sha256=sha256,
                cache_namespace=cache_namespace,
                can_cache=can_cache,
                parser=lambda: parse_report_xml(fpath),
            )

        if fpath.endswith(".dashboard-meta.xml"):
            return await self._execute_simple_parse(
                fpath,
                sha256=sha256,
                cache_namespace=cache_namespace,
                can_cache=can_cache,
                parser=lambda: parse_dashboard_xml(fpath),
            )

        if fpath.endswith(".labels-meta.xml") or fpath.endswith(".label-meta.xml"):
            return await self._execute_simple_parse(
                fpath,
                sha256=sha256,
                cache_namespace=cache_namespace,
                can_cache=can_cache,
                parser=lambda: parse_labels_xml(fpath),
            )

        if path.suffix == ".json" and is_vlocity_datapack_file(path):
            nodes, edges, meta = parse_vlocity_json_detailed(fpath, standards=self._vlocity_rule_bundle)
            metadata = {
                "outcome": meta.outcome,
                "pack_type": meta.pack_type,
                "parser_strategy": meta.parser_strategy,
                "node_label": meta.node_label,
                "unsupported_type": meta.unsupported_type,
                "standards_rule_source": meta.standards_rule_source,
                "matching_key_fields": list(meta.matching_key_fields),
            }
            await self._cache_result(cache_namespace, sha256, can_cache, nodes, edges, metadata)
            return nodes, edges, metadata

        return [], [], {"outcome": "skipped"}

    async def _execute_simple_parse(
        self,
        fpath: str,
        *,
        sha256: str | None,
        cache_namespace: str,
        can_cache: bool,
        parser: Callable[[], tuple[list[NodeFact], list[EdgeFact]]],
    ) -> tuple[list[NodeFact], list[EdgeFact], dict[str, Any]]:
        nodes, edges = parser()
        metadata = {"outcome": "parsed"}
        await self._cache_result(cache_namespace, sha256, can_cache, nodes, edges, metadata)
        return nodes, edges, metadata

    async def _parse_apex_file(
        self,
        fpath: str,
        path: Path,
        *,
        sha256: str | None,
        cache_namespace: str,
        can_cache: bool,
    ) -> tuple[list[NodeFact], list[EdgeFact], dict[str, Any]]:
        result = await self._pool.parse(fpath, "apex")
        if not result.get("ok") and str(result.get("error", "")) in TRANSIENT_WORKER_ERRORS:
            await asyncio.sleep(0.05)
            result = await self._pool.parse(fpath, "apex")
        if not result.get("ok"):
            error = str(result.get("error") or "worker_parse_failed")
            payload = result.get("payload")
            detail_suffix = self._format_parser_failure_details(payload)
            if detail_suffix:
                raise RuntimeError(f"{error} | {detail_suffix}")
            raise RuntimeError(error)
        payload = result.get("payload") or {}
        nodes, edges = self._apex_extractor.extract(payload, fpath)

        primary_class = next((n.key_props.get("qualifiedName") for n in nodes if n.label == "ApexClass"), path.stem)
        for ref in payload.get("potential_refs", []):
            if ref.get("refType") != "CALLS_CLASS_METHOD":
                continue
            target_class = ref.get("targetClass", "")
            target_method = ref.get("method", "")
            if not target_class or not target_method:
                continue
            edges.extend(
                self._dynamic_registry.match(
                    class_name=target_class,
                    method_name=target_method,
                    src_qualified_name=primary_class,
                    src_label="ApexClass",
                    context_snippet=ref.get("contextSnippet", ""),
                )
            )

        metadata = {"outcome": "parsed", "parser_strategy": "specialized", "node_label": "ApexClass"}
        await self._cache_result(cache_namespace, sha256, can_cache, nodes, edges, metadata)
        return nodes, edges, metadata

    async def _cache_result(
        self,
        cache_namespace: str,
        sha256: str | None,
        can_cache: bool,
        nodes: list[NodeFact],
        edges: list[EdgeFact],
        metadata: dict[str, Any],
    ) -> None:
        if self._parse_cache and sha256 and can_cache:
            await self._parse_cache.put(
                cache_namespace,
                sha256,
                self._serialize_parse_result(nodes, edges, metadata),
            )
