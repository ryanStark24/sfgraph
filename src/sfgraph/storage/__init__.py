"""Public storage exports.

The default product path uses DuckDB, so FalkorDB remains optional. Importing
sfgraph.storage must not fail on machines that do not install the FalkorDB
client dependency.
"""

from sfgraph.storage.base import GraphStore
from sfgraph.storage.duckpgq_store import DuckPGQStore
from sfgraph.storage.manifest_store import ManifestStore
from sfgraph.storage.vector_store import VectorStore

try:
    from sfgraph.storage.falkordb_store import FalkorDBStore
except ModuleNotFoundError as exc:
    if exc.name != "falkordb":
        raise

    class FalkorDBStore:  # type: ignore[no-redef]
        """Placeholder that keeps imports working when falkordb is absent."""

        def __init__(self, *args, **kwargs) -> None:
            raise ModuleNotFoundError(
                "Optional dependency 'falkordb' is not installed. "
                "Install it to use FalkorDBStore."
            )


__all__ = ["GraphStore", "DuckPGQStore", "FalkorDBStore", "ManifestStore", "VectorStore"]
