"""Tests for query agent wrappers and LLM fallback behavior."""
from __future__ import annotations

from sfgraph.query.agents import QueryCorrectorAgent, QueryPlannerAgent, ResultFormatterAgent, SchemaFilterAgent


def _heuristic_filter(question: str, labels: list[str], rels: list[str]) -> dict[str, list[str]]:
    _ = question
    return {"labels": labels[:2], "relationships": rels[:2]}


def test_schema_filter_heuristic_mode(monkeypatch):
    monkeypatch.delenv("OPENAI_API_KEY", raising=False)
    agent = SchemaFilterAgent()
    filtered, trace = agent.run(
        question="what uses Account.Status__c?",
        labels=["SFField", "ApexClass", "Flow"],
        rels=["READS_FIELD", "FLOW_READS_FIELD"],
        heuristic_filter=_heuristic_filter,
    )
    assert filtered["labels"]
    assert trace.strategy == "heuristic"


def test_schema_filter_llm_override(monkeypatch):
    monkeypatch.setenv("OPENAI_API_KEY", "test-key")
    agent = SchemaFilterAgent()
    # Avoid network in test.
    agent._llm.complete_json = lambda *_args, **_kwargs: {  # type: ignore[assignment]
        "labels": ["Flow"],
        "relationships": ["FLOW_READS_FIELD"],
        "reason": "flow centric",
    }
    filtered, trace = agent.run(
        question="which flow reads Account.Status__c?",
        labels=["SFField", "ApexClass", "Flow"],
        rels=["READS_FIELD", "FLOW_READS_FIELD"],
        heuristic_filter=_heuristic_filter,
    )
    assert filtered["labels"] == ["Flow"]
    assert filtered["relationships"] == ["FLOW_READS_FIELD"]
    assert trace.strategy == "llm"


def test_planner_corrector_formatter_llm_safe(monkeypatch):
    monkeypatch.setenv("OPENAI_API_KEY", "test-key")
    planner = QueryPlannerAgent()
    corrector = QueryCorrectorAgent()
    formatter = ResultFormatterAgent()

    planner._llm.complete_json = lambda *_args, **_kwargs: {"reason": "impact intent"}  # type: ignore[assignment]
    corrector._llm.complete_json = lambda *_args, **_kwargs: {"hint": "use broader label filter"}  # type: ignore[assignment]
    formatter._llm.complete_json = lambda *_args, **_kwargs: {"style": "terse"}  # type: ignore[assignment]

    p = planner.run("what breaks if I change Account.Status__c?", "trace_downstream")
    c = corrector.run([{"status": "error"}, {"status": "ok"}])
    f = formatter.run(12)

    assert p.strategy == "llm" and "reason=" in p.detail
    assert c.strategy == "llm" and "hint=" in c.detail
    assert f.strategy == "llm" and "style=" in f.detail
