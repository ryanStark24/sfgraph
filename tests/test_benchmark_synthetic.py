"""Tests for synthetic benchmark export generation."""
from __future__ import annotations

from pathlib import Path

from sfgraph.benchmark_synthetic import generate_synthetic_export


def test_generate_synthetic_export_creates_expected_files(tmp_path: Path):
    out = Path(
        generate_synthetic_export(
            output_dir=str(tmp_path / "synthetic"),
            class_count=3,
            flow_count=2,
        )
    )
    assert (out / "classes" / "SynthService1.cls").exists()
    assert (out / "classes" / "SynthService3.cls").exists()
    assert (out / "flows" / "SynthFlow1.flow-meta.xml").exists()
    assert (out / "flows" / "SynthFlow2.flow-meta.xml").exists()
    assert (out / "objects" / "Account" / "Account.object-meta.xml").exists()
