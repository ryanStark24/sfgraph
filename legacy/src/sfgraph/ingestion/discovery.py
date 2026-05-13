"""File discovery helpers for ingestion."""
from __future__ import annotations

import fnmatch
import os
from pathlib import Path
from typing import Any, Callable

from sfgraph.common import compute_sha256
from sfgraph.ingestion.parser_dispatch import is_supported_source_file

DEFAULT_DISCOVERY_ROOTS = ("force-app", "vlocity")
SKIP_DIR_NAMES = frozenset(
    {
        ".git",
        ".hg",
        ".svn",
        ".sfdx",
        ".sf",
        "node_modules",
        ".venv",
        "venv",
        "__pycache__",
        ".pytest_cache",
        ".mypy_cache",
        ".cache",
        "dist",
        "build",
    }
)
SKIP_FILE_PREFIXES = ("~$",)
SKIP_FILE_SUFFIXES = (".tmp", ".swp", ".swo")


def sfdx_package_directories(root: Path) -> list[Path]:
    config_path = root / "sfdx-project.json"
    if not config_path.exists():
        return []
    try:
        payload = __import__("json").loads(config_path.read_text(encoding="utf-8"))
    except Exception:
        return []
    package_dirs = payload.get("packageDirectories")
    if not isinstance(package_dirs, list):
        return []
    discovered: list[Path] = []
    seen: set[str] = set()
    for entry in package_dirs:
        if not isinstance(entry, dict):
            continue
        rel_path = entry.get("path")
        if not isinstance(rel_path, str) or not rel_path.strip():
            continue
        candidate = (root / rel_path).expanduser()
        resolved = candidate.resolve()
        key = str(resolved)
        if key in seen or not resolved.exists() or not resolved.is_dir():
            continue
        seen.add(key)
        discovered.append(resolved)
    return discovered


def discovery_roots(export_path: Path, *, include_globs: list[str] | None = None) -> list[Path]:
    root = export_path.resolve()
    if include_globs:
        return [root]
    if root.name in DEFAULT_DISCOVERY_ROOTS:
        return [root]
    discovered: list[Path] = []
    seen: set[str] = set()

    def _add(candidate: Path) -> None:
        resolved = candidate.resolve()
        key = str(resolved)
        if not resolved.exists() or not resolved.is_dir() or key in seen:
            return
        seen.add(key)
        discovered.append(resolved)

    for package_dir in sfdx_package_directories(root):
        _add(package_dir)
    for child in sorted(root.iterdir()):
        if child.is_dir() and child.name in DEFAULT_DISCOVERY_ROOTS:
            _add(child)
    return discovered or [root]


def should_skip_file(path: Path) -> bool:
    name = path.name
    if any(name.startswith(prefix) or prefix in name for prefix in SKIP_FILE_PREFIXES):
        return True
    if any(name.endswith(suffix) for suffix in SKIP_FILE_SUFFIXES):
        return True
    return False


def matches_discovery_rules(path: Path, root: Path, *, include_globs: list[str] | None = None, exclude_globs: list[str] | None = None) -> bool:
    relative = path.relative_to(root).as_posix()
    if include_globs and not any(fnmatch.fnmatch(relative, pattern) for pattern in include_globs):
        return False
    if exclude_globs and any(fnmatch.fnmatch(relative, pattern) for pattern in exclude_globs):
        return False
    return True


async def discover_file_records(
    export_path: Path,
    *,
    tracked_files: dict[str, dict[str, Any]],
    include_globs: list[str] | None = None,
    exclude_globs: list[str] | None = None,
    stat_fingerprint_matches: Callable[[dict[str, Any] | None, os.stat_result], bool],
    raise_if_cancelled: Callable[[], None],
    emit_progress: Callable[..., None] | None = None,
    progress_payload: Callable[..., dict[str, Any]] | None = None,
    empty_parser_stats: Callable[[], dict[str, dict[str, int]]] | None = None,
    run_id: str | None = None,
    mode: str = "full_ingest",
) -> dict[str, dict[str, int | str]]:
    """Discover ingestion targets and reuse stored hashes when file stats match."""
    files: dict[str, dict[str, int | str]] = {}
    root = export_path.resolve()
    scanned_files = 0
    hashed_files = 0
    reused_hashes = 0
    for discovery_root in discovery_roots(root, include_globs=include_globs):
        for current_root, dirs, filenames in os.walk(discovery_root, topdown=True):
            raise_if_cancelled()
            current_path = Path(current_root)
            dirs[:] = [d for d in dirs if d not in SKIP_DIR_NAMES]

            if current_path != discovery_root and any((current_path / marker).exists() for marker in (".git", ".hg", ".svn")):
                dirs[:] = []
                continue

            for filename in sorted(filenames):
                raise_if_cancelled()
                path = current_path / filename
                scanned_files += 1
                if should_skip_file(path):
                    continue
                if not matches_discovery_rules(path, root, include_globs=include_globs, exclude_globs=exclude_globs):
                    continue
                if not is_supported_source_file(path):
                    continue
                stat = path.stat()
                tracked_file = tracked_files.get(str(path))
                if stat_fingerprint_matches(tracked_file, stat):
                    sha = str(tracked_file["sha256"])
                    reused_hashes += 1
                else:
                    sha = compute_sha256(str(path))
                    hashed_files += 1
                files[str(path)] = {
                    "sha256": sha,
                    "size_bytes": stat.st_size,
                    "mtime_ns": stat.st_mtime_ns,
                    "ctime_ns": getattr(stat, "st_ctime_ns", None),
                }
                if run_id and emit_progress and progress_payload and empty_parser_stats:
                    emit_progress(
                        **progress_payload(
                            run_id=run_id,
                            mode=mode,
                            state="running",
                            phase="discovering",
                            export_dir=str(root),
                            total_files=max(scanned_files, 1),
                            processed_files=hashed_files + reused_hashes,
                            failed_files=0,
                            current_file=str(path),
                            current_parser="discovery",
                            parser_stats=empty_parser_stats(),
                            unresolved_symbols=0,
                            warnings_count=0,
                            discovery_scanned_files=scanned_files,
                            discovery_discovered_files=len(files),
                            discovery_hashed_files=hashed_files,
                            discovery_reused_hashes=reused_hashes,
                        )
                    )
    return files
