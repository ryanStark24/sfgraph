"""Question parsing and lightweight trigger-analysis helpers."""
from __future__ import annotations

import re


def component_token_query_parts(question: str) -> tuple[str, str] | None:
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


def looks_like_method_reference(question: str) -> bool:
    q = " ".join(question.strip().split())
    match = re.search(r"\b([A-Z][A-Za-z0-9_]*)\.([a-z][A-Za-z0-9_]*)\b", q)
    if not match:
        return False
    token = match.group(2)
    return not re.search(r"__(?:c|r|mdt|e)$", token)


def object_event_query_parts(question: str) -> tuple[str, str] | None:
    q = " ".join(question.strip().split())
    patterns = (
        r"\bwhat\s+happens\s+when\s+(?:a|an)?\s*([A-Za-z_][A-Za-z0-9_]*)\s+is\s+(inserted|updated|deleted|undeleted)\b",
        r"\bwhat\s+runs\s+when\s+(?:a|an)?\s*([A-Za-z_][A-Za-z0-9_]*)\s+is\s+(inserted|updated|deleted|undeleted)\b",
        r"\b(?:on|for)\s+([A-Za-z_][A-Za-z0-9_]*)\s+(insert|update|delete|undelete)\b",
    )
    for pattern in patterns:
        match = re.search(pattern, q, flags=re.IGNORECASE)
        if not match:
            continue
        object_name = match.group(1)
        raw_event = match.group(2).lower()
        event_map = {
            "inserted": "insert",
            "updated": "update",
            "deleted": "delete",
            "undeleted": "undelete",
            "insert": "insert",
            "update": "update",
            "delete": "delete",
            "undelete": "undelete",
        }
        return object_name, event_map.get(raw_event, raw_event)
    return None


def change_query_target(question: str) -> str | None:
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


def parse_trigger_declaration(text: str) -> tuple[str, str, set[str]] | None:
    match = re.search(r"trigger\s+([A-Za-z_][A-Za-z0-9_]*)\s+on\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(([^)]*)\)", text, re.IGNORECASE | re.DOTALL)
    if not match:
        return None
    trigger_name = match.group(1)
    object_name = match.group(2)
    events = {event.strip().lower() for event in match.group(3).split(",") if event.strip()}
    return trigger_name, object_name, events


def extract_method_calls(text: str) -> list[dict[str, str]]:
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
