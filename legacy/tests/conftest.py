# tests/conftest.py
"""Shared pytest fixtures for sfgraph test suite."""
import pytest
import tempfile
import os
from pathlib import Path


@pytest.fixture
def tmp_db_path(tmp_path: Path) -> str:
    """Return a temporary SQLite database path that is cleaned up after the test."""
    return str(tmp_path / "test_manifest.db")


@pytest.fixture
def tmp_graph_db_path(tmp_path: Path) -> str:
    """Return a temporary FalkorDB database path."""
    return str(tmp_path / "test_graph.db")


@pytest.fixture
def tmp_vector_path(tmp_path: Path) -> str:
    """Return a temporary Qdrant storage path."""
    return str(tmp_path / "test_vectors")


@pytest.fixture
def sample_file_path(tmp_path: Path) -> str:
    """Create a small sample file and return its path (for SHA-256 hashing tests)."""
    p = tmp_path / "sample.cls"
    p.write_text("public class SampleClass { public void run() {} }")
    return str(p)
