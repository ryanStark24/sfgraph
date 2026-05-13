"""Pydantic data models for ingestion pipeline facts.

NodeFact and EdgeFact are the interchange format between parsers and
IngestionService. All fields required by INGEST-04 and INGEST-06 are
enforced here so parsers cannot forget source attribution.
"""
from __future__ import annotations

from datetime import datetime, timezone
from enum import Enum
from typing import Any, Literal

from pydantic import BaseModel, field_validator, model_validator

from sfgraph.ingestion.constants import EDGE_CATEGORIES


class IngestionPhase(str, Enum):
    BOOTSTRAP = "bootstrap"
    PLANNING_REFRESH = "planning_refresh"
    DISCOVERING = "discovering"
    PARSING = "parsing"
    WRITING_NODES = "writing_nodes"
    WRITING_EDGES = "writing_edges"
    VECTORIZING = "vectorizing"
    COMPLETED = "completed"
    FAILED = "failed"
    CANCELLED = "cancelled"


class IngestionState(str, Enum):
    IDLE = "idle"
    QUEUED = "queued"
    RUNNING = "running"
    CANCELLING = "cancelling"
    COMPLETED = "completed"
    FAILED = "failed"
    CANCELLED = "cancelled"


class NodeFact(BaseModel):
    """A parsed node ready to be written via GraphStore.merge_node().

    INGEST-04: sourceFile, lineNumber, parserType, lastIngestedAt are mandatory.
    """
    label: str                    # Must be one of NODE_TYPES
    key_props: dict[str, Any]     # Props used for MERGE identity (e.g. qualifiedName)
    all_props: dict[str, Any]     # All props to SET after match/create

    # INGEST-04 source attribution — enforced here, not optional
    sourceFile: str
    lineNumber: int = 0
    parserType: str               # "xml_object" | "xml_flow" | "apex_cst" | "manual"
    lastIngestedAt: str = ""      # ISO 8601 UTC, set by IngestionService if empty

    @field_validator("sourceFile")
    @classmethod
    def validate_source_file(cls, v: str) -> str:
        if not v:
            raise ValueError("sourceFile must not be empty")
        return v

    @model_validator(mode="after")
    def inject_attribution(self) -> "NodeFact":
        if not self.lastIngestedAt:
            self.lastIngestedAt = datetime.now(timezone.utc).isoformat()
        # Ensure source attribution props are also in all_props for merge_node()
        self.all_props["sourceFile"] = self.sourceFile
        self.all_props["lineNumber"] = self.lineNumber
        self.all_props["parserType"] = self.parserType
        self.all_props["lastIngestedAt"] = self.lastIngestedAt
        return self


class EdgeFact(BaseModel):
    """A potential relationship to be resolved and written via GraphStore.merge_edge().

    INGEST-06: confidence, resolutionMethod, edgeCategory, contextSnippet are mandatory.
    """
    src_qualified_name: str
    src_label: str
    rel_type: str
    dst_qualified_name: str
    dst_label: str

    # INGEST-06 edge attribution
    confidence: float             # 0.0 - 1.0
    resolutionMethod: str         # "direct" | "regex" | "cst" | "traced" | "stub"
    edgeCategory: str             # Must be one of EDGE_CATEGORIES
    contextSnippet: str = ""      # 1-3 line source excerpt

    @field_validator("edgeCategory")
    @classmethod
    def validate_edge_category(cls, v: str) -> str:
        if v not in EDGE_CATEGORIES:
            raise ValueError(
                f"edgeCategory must be one of {sorted(EDGE_CATEGORIES)}, got {v!r}"
            )
        return v

    @field_validator("confidence")
    @classmethod
    def validate_confidence(cls, v: float) -> float:
        if not 0.0 <= v <= 1.0:
            raise ValueError(f"confidence must be 0.0-1.0, got {v}")
        return v

    def to_merge_props(self) -> dict[str, Any]:
        """Return props dict suitable for GraphStore.merge_edge()."""
        return {
            "confidence": self.confidence,
            "resolutionMethod": self.resolutionMethod,
            "edgeCategory": self.edgeCategory,
            "contextSnippet": self.contextSnippet,
        }


class IngestionSummary(BaseModel):
    """Returned by IngestionService.ingest() on completion. INGEST-08."""
    run_id: str
    export_dir: str
    duration_seconds: float
    node_counts_by_type: dict[str, int]
    edge_count: int
    parse_failures: list[str]        # file paths that failed parsing
    orphaned_edges: int              # edges whose src or dst could not be found
    warnings: list[str]
    parser_stats: dict[str, dict[str, int]] = {}
    unresolved_symbols: int = 0

    @property
    def total_nodes(self) -> int:
        return sum(self.node_counts_by_type.values())


class RefreshSummary(BaseModel):
    """Returned by IngestionService.refresh() incremental update runs."""

    run_id: str
    export_dir: str
    duration_seconds: float
    processed_files: int
    changed_files: list[str]
    deleted_files: list[str]
    affected_neighbor_files: list[str] = []
    node_count: int
    edge_count: int
    orphaned_edges: int
    warnings: list[str]
    parser_stats: dict[str, dict[str, int]] = {}
    unresolved_symbols: int = 0


class VectorizeSummary(BaseModel):
    """Returned by IngestionService.vectorize() when vectors are rebuilt."""

    run_id: str
    export_dir: str
    duration_seconds: float
    processed_nodes: int
    failed_nodes: int = 0
    skipped_nodes: int
    warnings: list[str]
