# src/sfgraph/server.py
# CRITICAL: stderr redirect must be the FIRST executable lines — before any other imports.
# Any output to stdout before this redirect corrupts the MCP stdio JSON-RPC transport.
import sys
import logging

logging.basicConfig(
    stream=sys.stderr,
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(name)s: %(message)s",
)

# Only import other modules AFTER logging is configured.
# This prevents any library startup messages from reaching stdout.

logger = logging.getLogger(__name__)

# Placeholder: FastMCP server wiring is added in Phase 2.
# This module exists in Phase 1 solely to establish stdout discipline.

logger.info("sfgraph server module loaded (Phase 1 stub)")
