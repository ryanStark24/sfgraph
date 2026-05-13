from __future__ import annotations

import shutil
from pathlib import Path

import pytest

from sfgraph.parser import pool as pool_module


def test_resolve_node_prefers_sfgraph_node_binary_path(monkeypatch: pytest.MonkeyPatch, tmp_path: Path):
    fake_node = tmp_path / "node"
    fake_node.write_text("", encoding="utf-8")
    monkeypatch.setenv("SFGRAPH_NODE_BINARY", str(fake_node))
    monkeypatch.setattr(shutil, "which", lambda name: None)
    assert pool_module._resolve_node() == str(fake_node)


def test_resolve_node_uses_sfgraph_node_binary_command(monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setenv("SFGRAPH_NODE_BINARY", "node22")
    monkeypatch.setattr(shutil, "which", lambda name: "/custom/bin/node22" if name == "node22" else None)
    assert pool_module._resolve_node() == "/custom/bin/node22"


def test_resolve_node_falls_back_to_path(monkeypatch: pytest.MonkeyPatch):
    monkeypatch.delenv("SFGRAPH_NODE_BINARY", raising=False)
    monkeypatch.setattr(shutil, "which", lambda name: "/usr/bin/node" if name == "node" else None)
    assert pool_module._resolve_node() == "/usr/bin/node"


def test_resolve_node_raises_when_missing(monkeypatch: pytest.MonkeyPatch):
    monkeypatch.delenv("SFGRAPH_NODE_BINARY", raising=False)
    monkeypatch.setattr(shutil, "which", lambda name: None)
    with pytest.raises(RuntimeError, match="Node.js binary not found"):
        pool_module._resolve_node()

