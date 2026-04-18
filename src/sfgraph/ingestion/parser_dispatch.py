"""Discovery and parser-routing helpers for ingestion.

These functions are deliberately small and side-effect free so parser coverage
changes do not require editing the main IngestionService orchestration flow.
"""
from __future__ import annotations

from pathlib import Path

from sfgraph.parser.vlocity_parser import is_vlocity_datapack_file

AURA_MARKUP_SUFFIXES = (".cmp", ".app", ".evt", ".intf")
SUPPORTED_NON_JSON_SUFFIXES = (
    ".cls",
    ".trigger",
    *AURA_MARKUP_SUFFIXES,
    ".js",
    ".html",
    ".object-meta.xml",
    ".flow-meta.xml",
    ".labels-meta.xml",
    ".label-meta.xml",
    ".globalValueSet-meta.xml",
    ".md-meta.xml",
    ".workflow-meta.xml",
    ".permissionset-meta.xml",
    ".profile-meta.xml",
    ".namedCredential-meta.xml",
    ".report-meta.xml",
    ".dashboard-meta.xml",
)


def is_supported_source_file(path: Path) -> bool:
    if path.suffix == ".json":
        return is_vlocity_datapack_file(path)
    return any(path.name.endswith(suffix) for suffix in SUPPORTED_NON_JSON_SUFFIXES)


def parser_name_for_file(path: Path) -> str:
    if path.suffix in {".cls", ".trigger"}:
        return "apex"
    lowered_parts = {part.lower() for part in path.parts}
    if path.suffix in AURA_MARKUP_SUFFIXES and "aura" in lowered_parts:
        return "aura"
    if path.suffix in {".js", ".html"} and "lwc" in lowered_parts:
        return "lwc"
    file_name = path.name
    if file_name.endswith(".flow-meta.xml"):
        return "flow"
    if file_name.endswith(
        (
            ".object-meta.xml",
            ".globalValueSet-meta.xml",
            ".md-meta.xml",
            ".workflow-meta.xml",
            ".permissionset-meta.xml",
            ".profile-meta.xml",
            ".namedCredential-meta.xml",
            ".report-meta.xml",
            ".dashboard-meta.xml",
        )
    ):
        return "object"
    if file_name.endswith((".labels-meta.xml", ".label-meta.xml")):
        return "labels"
    if path.suffix == ".json" and is_vlocity_datapack_file(path):
        return "vlocity"
    return "unknown"
