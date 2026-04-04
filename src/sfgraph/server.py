# src/sfgraph/server.py
# CRITICAL: stderr redirect must be the FIRST executable lines — before any other imports.
import sys
import logging

logging.basicConfig(
    stream=sys.stderr,
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(name)s: %(message)s",
)

# Only import AFTER logging is configured.
from contextlib import asynccontextmanager
from dataclasses import dataclass

from mcp.server.fastmcp import FastMCP, Context

from sfgraph.storage.falkordb_store import FalkorDBStore
from sfgraph.storage.vector_store import VectorStore
from sfgraph.storage.manifest_store import ManifestStore
from sfgraph.parser.pool import NodeParserPool

logger = logging.getLogger(__name__)


@dataclass
class AppContext:
    graph: FalkorDBStore
    vectors: VectorStore
    manifest: ManifestStore
    pool: NodeParserPool


@asynccontextmanager
async def lifespan(server: FastMCP):
    """Initialize all storage handles and parser pool. MCP-01."""
    graph = FalkorDBStore(host="localhost", port=6379, graph_name="org_graph")
    vectors = VectorStore(path="./data/vectors")
    manifest = ManifestStore(db_path="./data/manifest.sqlite")
    pool = NodeParserPool()

    await pool.start()
    logger.info("All storage engines initialized")

    yield AppContext(graph=graph, vectors=vectors, manifest=manifest, pool=pool)

    await pool.shutdown()
    await graph.close()
    logger.info("All storage engines closed")


mcp = FastMCP("salesforce-org-graph", lifespan=lifespan)


@mcp.tool()
async def ping(ctx: Context) -> str:
    """Health check tool — confirms lifespan context is wired correctly."""
    app: AppContext = ctx.request_context.lifespan_context
    pool_size = len(app.pool._workers)
    return f"ok — pool_size={pool_size}"


if __name__ == "__main__":
    mcp.run()
