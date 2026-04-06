"""Tests for workspace path isolation guard in server tools."""
from __future__ import annotations

from pathlib import Path

import pytest

from sfgraph.server import _validate_workspace_export_dir


def test_validate_workspace_export_dir_allows_workspace_child(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    workspace = tmp_path / "repo"
    export_dir = workspace / "metadata"
    export_dir.mkdir(parents=True, exist_ok=True)
    monkeypatch.chdir(workspace)
    resolved = _validate_workspace_export_dir(str(export_dir))
    assert resolved == str(export_dir.resolve())


def test_validate_workspace_export_dir_blocks_external_path(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    workspace = tmp_path / "repo"
    outside = tmp_path / "outside"
    workspace.mkdir(parents=True, exist_ok=True)
    outside.mkdir(parents=True, exist_ok=True)
    monkeypatch.chdir(workspace)
    with pytest.raises(ValueError):
        _validate_workspace_export_dir(str(outside))
