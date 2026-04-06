"""Lightweight agent layer for schema filter, planning, correction, and formatting."""
from __future__ import annotations

import json
import os
from urllib import error as urlerror
from urllib import request as urlrequest
from dataclasses import dataclass
from typing import Any


@dataclass
class AgentTrace:
    name: str
    strategy: str
    detail: str


class LLMClient:
    """Minimal OpenAI API client for JSON responses with safe fallback."""

    def __init__(self) -> None:
        self._api_key = os.getenv("OPENAI_API_KEY", "")
        self._base_url = os.getenv("OPENAI_BASE_URL", "https://api.openai.com/v1").rstrip("/")
        self._model = os.getenv("SFGRAPH_AGENT_MODEL", "gpt-4.1-mini")
        self._enabled = bool(self._api_key) and os.getenv("SFGRAPH_DISABLE_LLM_AGENTS", "0") not in {"1", "true", "True"}

    @property
    def enabled(self) -> bool:
        return self._enabled

    @property
    def model(self) -> str:
        return self._model

    def _request_json(self, endpoint: str, payload: dict[str, Any], timeout: float = 6.0) -> dict[str, Any]:
        url = f"{self._base_url}/{endpoint.lstrip('/')}"
        body = json.dumps(payload).encode("utf-8")
        req = urlrequest.Request(
            url=url,
            data=body,
            headers={
                "Authorization": f"Bearer {self._api_key}",
                "Content-Type": "application/json",
            },
            method="POST",
        )
        with urlrequest.urlopen(req, timeout=timeout) as resp:
            return json.loads(resp.read().decode("utf-8"))

    @staticmethod
    def _extract_chat_json(payload: dict[str, Any]) -> dict[str, Any]:
        choices = payload.get("choices", [])
        if not choices:
            return {}
        content = choices[0].get("message", {}).get("content", "")
        if not content:
            return {}
        try:
            parsed = json.loads(content)
            return parsed if isinstance(parsed, dict) else {}
        except Exception:
            return {}

    def complete_json(self, system_prompt: str, user_prompt: str, timeout: float = 6.0) -> dict[str, Any]:
        if not self._enabled:
            return {}
        payload = {
            "model": self._model,
            "response_format": {"type": "json_object"},
            "messages": [
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": user_prompt},
            ],
            "temperature": 0.1,
        }
        try:
            result = self._request_json("/chat/completions", payload, timeout=timeout)
            return self._extract_chat_json(result)
        except (urlerror.URLError, TimeoutError, json.JSONDecodeError, KeyError, ValueError):
            return {}
        except Exception:
            return {}


class SchemaFilterAgent:
    def __init__(self) -> None:
        self._llm = LLMClient()

    @property
    def strategy(self) -> str:
        return "llm" if self._llm.enabled else "heuristic"

    def run(
        self,
        question: str,
        labels: list[str],
        rels: list[str],
        heuristic_filter: Any,
    ) -> tuple[dict[str, list[str]], AgentTrace]:
        filtered = heuristic_filter(question, labels, rels)
        llm_selected = {}
        if self._llm.enabled:
            llm_selected = self._llm.complete_json(
                system_prompt=(
                    "You are a schema filter for a graph query system. "
                    "Select the minimum relevant labels and relationships for the question. "
                    "Return JSON with keys: labels (list), relationships (list), reason (string)."
                ),
                user_prompt=json.dumps(
                    {
                        "question": question,
                        "labels": labels,
                        "relationships": rels,
                        "max_labels": 10,
                        "max_relationships": 12,
                    }
                ),
            )

        if isinstance(llm_selected, dict):
            sel_labels = [x for x in llm_selected.get("labels", []) if isinstance(x, str) and x in labels]
            sel_rels = [x for x in llm_selected.get("relationships", []) if isinstance(x, str) and x in rels]
            if sel_labels:
                filtered["labels"] = sel_labels[:10]
            if sel_rels:
                filtered["relationships"] = sel_rels[:12]

        trace = AgentTrace(
            name="schema_filter_agent",
            strategy=self.strategy,
            detail=f"selected {len(filtered['labels'])} labels and {len(filtered['relationships'])} relationships using {self._llm.model if self._llm.enabled else 'heuristic'}",
        )
        return filtered, trace


class QueryPlannerAgent:
    def __init__(self) -> None:
        self._llm = LLMClient()

    @property
    def strategy(self) -> str:
        return "llm" if self._llm.enabled else "heuristic"

    def run(self, question: str, intent: str) -> AgentTrace:
        detail = f"intent={intent} question_len={len(question)}"
        if self._llm.enabled:
            plan = self._llm.complete_json(
                system_prompt=(
                    "You are a query planner. Return JSON: "
                    '{"intent":"...", "reason":"..."} based on the user question.'
                ),
                user_prompt=json.dumps({"question": question, "heuristic_intent": intent}),
            )
            reason = plan.get("reason") if isinstance(plan, dict) else None
            if isinstance(reason, str) and reason:
                detail = f"{detail} reason={reason[:120]}"
        return AgentTrace(
            name="query_planner_agent",
            strategy=self.strategy,
            detail=detail,
        )


class QueryCorrectorAgent:
    def __init__(self) -> None:
        self._llm = LLMClient()

    @property
    def strategy(self) -> str:
        return "llm" if self._llm.enabled else "heuristic"

    def run(self, attempts: list[dict[str, Any]]) -> AgentTrace:
        failed = len([a for a in attempts if a.get("status") == "error"])
        detail = f"attempts={len(attempts)} failed={failed}"
        if self._llm.enabled and attempts:
            fix = self._llm.complete_json(
                system_prompt=(
                    "You are a query correction helper. "
                    "Given execution attempts, return JSON with one key 'hint'."
                ),
                user_prompt=json.dumps({"attempts": attempts[-4:]}),
            )
            hint = fix.get("hint") if isinstance(fix, dict) else None
            if isinstance(hint, str) and hint:
                detail = f"{detail} hint={hint[:120]}"
        return AgentTrace(
            name="query_corrector_agent",
            strategy=self.strategy,
            detail=detail,
        )


class ResultFormatterAgent:
    def __init__(self) -> None:
        self._llm = LLMClient()

    @property
    def strategy(self) -> str:
        return "llm" if self._llm.enabled else "heuristic"

    def run(self, finding_count: int) -> AgentTrace:
        detail = f"finding_count={finding_count}"
        if self._llm.enabled:
            fmt = self._llm.complete_json(
                system_prompt=(
                    "You are a result formatter policy helper. "
                    "Return JSON key 'style' with terse formatting guidance."
                ),
                user_prompt=json.dumps({"finding_count": finding_count}),
            )
            style = fmt.get("style") if isinstance(fmt, dict) else None
            if isinstance(style, str) and style:
                detail = f"{detail} style={style[:80]}"
        return AgentTrace(
            name="result_formatter_agent",
            strategy=self.strategy,
            detail=detail,
        )
