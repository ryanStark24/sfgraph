"""Helpers for exact repo scanning and token-level source matching."""
from __future__ import annotations

import os
import re
from pathlib import Path
from typing import Any

from sfgraph.ingestion.discovery import sfdx_package_directories


class ExactRetrievalHelper:
    """Repo-scanning heuristics used by exact query paths."""

    SKIP_DIR_NAMES = frozenset({".git", ".hg", ".svn", "node_modules", ".sf", ".sfdx", ".venv", "venv", "__pycache__"})
    EXACT_SEARCH_SUFFIXES = (
        ".cls",
        ".trigger",
        ".flow-meta.xml",
        ".object-meta.xml",
        ".labels-meta.xml",
        ".label-meta.xml",
        ".json",
        ".xml",
    )

    def __init__(self, repo_root: Path) -> None:
        self._repo_root = repo_root

    def iter_repo_files(self, suffixes: tuple[str, ...] | None = None):
        suffixes = suffixes or self.EXACT_SEARCH_SUFFIXES
        for current_root, dirs, filenames in os.walk(self._repo_root):
            dirs[:] = [d for d in dirs if d not in self.SKIP_DIR_NAMES]
            for filename in filenames:
                if not filename.endswith(suffixes):
                    continue
                yield Path(current_root) / filename

    @staticmethod
    def read_text_safe(path: Path) -> str:
        try:
            return path.read_text(encoding="utf-8", errors="ignore")
        except Exception:
            return ""

    @staticmethod
    def classify_exact_field_match(field_token: str, line: str, window: str, file_path: Path) -> tuple[str, float]:
        lower_line = line.lower()
        lower_window = window.lower()
        if file_path.suffix in {".cls", ".trigger"}:
            assignment_patterns = (
                rf"\b{re.escape(field_token)}\b\s*=",
                rf"\.\s*{re.escape(field_token)}\s*=",
                rf"\.put\(\s*['\"]{re.escape(field_token)}['\"]\s*,",
            )
            if any(re.search(pattern, line) for pattern in assignment_patterns):
                return "write", 0.98
            if re.search(rf"\.\s*get\(\s*['\"]{re.escape(field_token)}['\"]\s*\)", line):
                return "read", 0.95
            if any(keyword in lower_window for keyword in ("select ", "where ", ".get(", "map<", "jsonattribute", "serviceid")):
                return "read", 0.9
            return "mention", 0.75

        if file_path.suffix == ".json":
            if any(
                re.search(pattern, lower_line)
                for pattern in (
                    rf'"destinationfield"\s*:\s*"[^"]*{re.escape(field_token.lower())}[^"]*"',
                    rf'"destinationfields"\s*:\s*\[[^\]]*{re.escape(field_token.lower())}[^\]]*\]',
                )
            ):
                return "write", 0.92
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
    def classify_component_token_match(token: str, line: str, window: str, file_path: Path) -> tuple[str, float]:
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

    @staticmethod
    def extract_component_write_expression(token: str, line: str) -> str | None:
        escaped = re.escape(token)
        patterns = (
            rf"\b{escaped}\b\s*=\s*(?P<expr>[^;]+)",
            rf"\.\s*{escaped}\s*=\s*(?P<expr>[^;]+)",
            rf"\.put\(\s*['\"]{escaped}['\"]\s*,\s*(?P<expr>[^)]+)\)",
            rf"['\"]{escaped}['\"]\s*:\s*(?P<expr>[^,}}]+)",
        )
        for pattern in patterns:
            match = re.search(pattern, line)
            if not match:
                continue
            expr = str(match.group("expr")).strip()
            if expr:
                return expr
        return None

    @staticmethod
    def extract_field_write_expression(field_token: str, line: str) -> str | None:
        escaped = re.escape(field_token)
        patterns = (
            rf"\.\s*{escaped}\s*=\s*(?P<expr>[^;]+)",
            rf"\b{escaped}\b\s*=\s*(?P<expr>[^;]+)",
            rf"\.put\(\s*['\"]{escaped}['\"]\s*,\s*(?P<expr>[^)]+)\)",
            rf'"destinationfield"\s*:\s*"(?P<expr>[^"]+)"',
        )
        for pattern in patterns:
            match = re.search(pattern, line, flags=re.IGNORECASE)
            if not match:
                continue
            expr = str(match.group("expr")).strip()
            if expr:
                return expr
        return None

    @staticmethod
    def trace_variable_origin(symbol: str, lines: list[str], write_line: int) -> dict[str, Any] | None:
        escaped = re.escape(symbol)
        assign_pattern = re.compile(rf"\b{escaped}\b\s*=\s*(?P<expr>[^;]+)")
        decl_assign_pattern = re.compile(
            rf"\b(?:final\s+)?[A-Za-z_][A-Za-z0-9_<>,.\[\]]*\s+{escaped}\b\s*=\s*(?P<expr>[^;]+)"
        )
        for idx in range(write_line - 2, -1, -1):
            candidate = lines[idx]
            match = decl_assign_pattern.search(candidate) or assign_pattern.search(candidate)
            if not match:
                continue
            expr = str(match.group("expr")).strip()
            return {
                "source_symbol": symbol,
                "source_expression": expr,
                "source_line": idx + 1,
                "source_context": candidate.strip()[:240],
                "confidence": 0.92,
                "resolution": "intra_file_backtrack",
            }
        return None

    def origin_for_component_write(self, token: str, line: str, lines: list[str], write_line: int) -> dict[str, Any] | None:
        expr = self.extract_component_write_expression(token, line)
        if not expr:
            return None
        rhs_symbol_match = re.fullmatch(r"\(?\s*(?:String|Id|Object|Decimal|Integer|Long|Double|Boolean)?\s*\)?\s*([A-Za-z_][A-Za-z0-9_]*)", expr)
        if rhs_symbol_match:
            symbol = rhs_symbol_match.group(1)
            traced = self.trace_variable_origin(symbol, lines, write_line)
            if traced:
                traced["write_expression"] = expr
                return traced
        return {
            "source_symbol": None,
            "source_expression": expr,
            "source_line": write_line,
            "source_context": line.strip()[:240],
            "confidence": 0.97,
            "resolution": "direct_rhs_expression",
        }

    def package_metadata_roots(self) -> list[Path]:
        candidates = self.sfdx_package_directories()
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

    def sfdx_package_directories(self) -> list[Path]:
        return [path.resolve() for path in sfdx_package_directories(self._repo_root)]

    def find_component_source_files(self, component_name: str, max_results: int = 20) -> list[Path]:
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

        exact_roots: list[Path] = []
        for metadata_root in self.package_metadata_roots():
            exact_roots.append(metadata_root / "classes")
            exact_roots.append(metadata_root / "triggers")
        exact_roots.append(self._repo_root / "vlocity")

        for suffix in (".cls", ".trigger", ".js", ".ts", ".xml", ".json"):
            for root in exact_roots:
                _add(root / f"{name}{suffix}")
            if len(out) >= max_results:
                return out[:max_results]

        class_pattern = re.compile(rf"\b(?:class|trigger)\s+{re.escape(name)}\b", re.IGNORECASE)
        allowed_exts = {".cls", ".trigger", ".js", ".ts", ".xml", ".json"}
        for root in exact_roots:
            if not root.exists():
                continue
            for path in root.rglob("*"):
                if not path.is_file() or path.suffix.lower() not in allowed_exts:
                    continue
                text = self.read_text_safe(path)
                if not text:
                    continue
                if class_pattern.search(text) or name in text:
                    _add(path)
                    if len(out) >= max_results:
                        return out[:max_results]
        return out[:max_results]
