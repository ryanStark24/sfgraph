"""Human-readable ingest diagnostics export."""
from __future__ import annotations

from dataclasses import dataclass
import json
from pathlib import Path
from typing import Any

from sfgraph.contracts import DiagnosticsReporter


@dataclass
class IngestionDiagnosticsReporter(DiagnosticsReporter):
    ingestion_meta_path: str
    ingestion_progress_path: str

    def export_markdown(
        self,
        *,
        destination: str | Path | None = None,
        context: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        meta = self._read_json(Path(self.ingestion_meta_path))
        progress = self._read_json(Path(self.ingestion_progress_path))
        context = context or {}
        export_dir = str(context.get("export_dir") or meta.get("export_dir") or "")
        report_path = Path(destination) if destination else Path(self.ingestion_meta_path).with_name("ingestion_diagnostics.md")
        report_path.parent.mkdir(parents=True, exist_ok=True)
        report_path.write_text(self._render(meta=meta, progress=progress, context=context), encoding="utf-8")
        return {
            "path": str(report_path),
            "export_dir": export_dir,
            "run_id": meta.get("run_id") or progress.get("run_id"),
            "summary": {
                "state": progress.get("state", "idle"),
                "phase": progress.get("phase"),
                "parse_failures": meta.get("parse_failures", []),
                "warnings": meta.get("warnings", []),
                "parser_stats": meta.get("parser_stats", {}),
            },
        }

    @staticmethod
    def _read_json(path: Path) -> dict[str, Any]:
        if not path.exists():
            return {}
        try:
            payload = json.loads(path.read_text(encoding="utf-8"))
        except Exception:
            return {}
        return payload if isinstance(payload, dict) else {}

    def _render(self, *, meta: dict[str, Any], progress: dict[str, Any], context: dict[str, Any]) -> str:
        lines = ["# Ingestion Diagnostics", ""]
        summary_rows = [
            ("Run ID", str(meta.get("run_id") or progress.get("run_id") or "unknown")),
            ("Export Dir", str(context.get("export_dir") or meta.get("export_dir") or "unknown")),
            ("State", str(progress.get("state") or "idle")),
            ("Phase", str(progress.get("phase") or "n/a")),
            ("Indexed At", str(meta.get("indexed_at") or "n/a")),
            ("Project Scope", str(meta.get("project_scope") or "n/a")),
        ]
        lines.extend([f"- {label}: {value}" for label, value in summary_rows])
        lines.extend(["", "## Parser Stats", ""])
        parser_stats = meta.get("parser_stats", {})
        if isinstance(parser_stats, dict) and parser_stats:
            for parser_name, stats in sorted(parser_stats.items()):
                if not isinstance(stats, dict):
                    continue
                metrics = ", ".join(f"{key}={value}" for key, value in sorted(stats.items()))
                lines.append(f"- `{parser_name}`: {metrics}")
        else:
            lines.append("- No parser stats available.")

        lines.extend(["", "## Parse Failures", ""])
        parse_failures = meta.get("parse_failures", [])
        if isinstance(parse_failures, list) and parse_failures:
            lines.extend([f"- `{item}`" for item in parse_failures])
        else:
            lines.append(f"- Count: {meta.get('parse_failures', 0)}")

        lines.extend(["", "## Warnings", ""])
        warnings = meta.get("warnings", [])
        if isinstance(warnings, list) and warnings:
            lines.extend([f"- {item}" for item in warnings])
        else:
            lines.append(f"- Count: {meta.get('warnings', 0)}")

        lines.extend(["", "## Progress Snapshot", "", "```json", json.dumps(progress or {}, indent=2), "```", ""])
        return "\n".join(lines)
