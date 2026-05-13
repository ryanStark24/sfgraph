"""Shared interface contracts for swappable sfgraph subsystems.

These protocols are intentionally small. They document the seams between
standards loading, parsing, retrieval, and diagnostics without forcing a
specific storage or parser implementation.
"""
from __future__ import annotations

from pathlib import Path
from typing import Any, Protocol

from sfgraph.ingestion.models import EdgeFact, NodeFact


class StandardsProvider(Protocol):
    """Resolve metadata standards and identity rules for a workspace."""

    def resolve_bundle(
        self,
        export_dir: str | Path,
        *,
        org_alias: str | None = None,
        org_context: dict[str, Any] | None = None,
    ) -> Any:
        ...


class ParserAdapter(Protocol):
    """Parse one source file into graph facts plus structured metadata."""

    def parse(self, file_path: str | Path) -> tuple[list[NodeFact], list[EdgeFact], dict[str, Any]]:
        ...


class RetrievalEngine(Protocol):
    """Minimal retrieval surface used by higher-level query orchestration."""

    async def analyze(self, question: str, **kwargs: Any) -> dict[str, Any]:
        ...


class DiagnosticsReporter(Protocol):
    """Render persisted ingest/query diagnostics into a user-facing artifact."""

    def export_markdown(
        self,
        *,
        destination: str | Path | None = None,
        context: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        ...
