from __future__ import annotations

from pathlib import Path
from types import SimpleNamespace

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
