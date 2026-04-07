from __future__ import annotations

from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest

from sfgraph import server


class _FakeJobs:
    active_job_id = "job-123"

    async def get_active_job(self):
        return {
            "job_id": "job-123",
            "job_type": "ingest",
            "state": "running",
            "export_dir": "/tmp/repo",
        }


def _ctx_with_active_job():
    app = SimpleNamespace(jobs=_FakeJobs())
    return SimpleNamespace(request_context=SimpleNamespace(lifespan_context=app))


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("tool", "kwargs"),
    [
        (server.ingest_org, {"mode": "full"}),
        (server.refresh, {"mode": "full"}),
        (server.vectorize, {}),
        (
            server.watch_refresh,
            {
                "duration_seconds": 1,
                "poll_interval": 0.1,
                "debounce_seconds": 0.1,
                "max_refreshes": 1,
            },
        ),
    ],
)
async def test_blocking_tools_reject_when_background_job_active(
    tool,
    kwargs,
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
):
    workspace = tmp_path / "repo"
    workspace.mkdir(parents=True, exist_ok=True)
    monkeypatch.chdir(workspace)

    with pytest.raises(RuntimeError, match="cannot run while background job"):
        await tool(str(workspace), _ctx_with_active_job(), **kwargs)


@pytest.mark.asyncio
async def test_deprecated_refresh_and_vectorize_pass_parse_cache(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
):
    workspace = tmp_path / "repo"
    workspace.mkdir(parents=True, exist_ok=True)
    monkeypatch.chdir(workspace)

    app = SimpleNamespace(
        graph=object(),
        manifest=object(),
        parse_cache=object(),
        pool=object(),
        vectors=object(),
        data_root=tmp_path / "data",
        jobs=SimpleNamespace(get_active_job=AsyncMock(return_value=None)),
    )
    ctx = SimpleNamespace(request_context=SimpleNamespace(lifespan_context=app))

    captured: list[dict[str, object]] = []

    def fake_build_ingestion_service_from_parts(**kwargs):
        captured.append(kwargs)
        return SimpleNamespace(
            refresh=AsyncMock(
                return_value=SimpleNamespace(
                    run_id="run-1",
                    export_dir=str(workspace),
                    duration_seconds=0.1,
                    processed_files=0,
                    changed_files=[],
                    deleted_files=[],
                    affected_neighbor_files=[],
                    node_count=0,
                    edge_count=0,
                    orphaned_edges=0,
                    parser_stats={},
                    unresolved_symbols=0,
                    warnings=[],
                )
            ),
            vectorize=AsyncMock(return_value=SimpleNamespace(model_dump=lambda: {"run_id": "run-2"})),
        )

    monkeypatch.setattr(server, "_build_ingestion_service_from_parts", fake_build_ingestion_service_from_parts)

    await server.refresh(str(workspace), ctx, mode="full")
    await server.vectorize(str(workspace), ctx)

    assert len(captured) == 2
    assert all(call["parse_cache"] is app.parse_cache for call in captured)
