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

