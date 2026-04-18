"""Shared low-level helpers used across ingestion/query/storage."""
from __future__ import annotations

import hashlib
import json
from typing import Any


def parse_json_props(value: Any) -> dict[str, Any]:
    """Best-effort decode of JSON-like props payloads."""
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


def compute_sha256(path: str) -> str:
    """Compute SHA-256 digest for a file path."""
    digest = hashlib.sha256()
    with open(path, "rb") as fh:
        for chunk in iter(lambda: fh.read(65536), b""):
            digest.update(chunk)
    return digest.hexdigest()


def descope_qname(qualified_name: str) -> str:
    """Drop project scope prefix (`scope::`) when present."""
    if "::" not in qualified_name:
        return qualified_name
    return qualified_name.split("::", 1)[1]


def scope_qname(scope: str | None, qualified_name: str) -> str:
    """Apply project scope prefix when needed."""
    if not qualified_name:
        return qualified_name
    if "::" in qualified_name or not scope:
        return qualified_name
    return f"{scope}::{qualified_name}"
