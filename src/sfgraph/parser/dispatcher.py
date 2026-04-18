# src/sfgraph/parser/dispatcher.py
"""ParseDispatcher — stateless file-extension-based routing to parser targets.

Routes files to the appropriate parser based on file extension:
  .cls, .trigger        → nodejs_pool  (Apex)
  .js, .xml, .html, .json → python_parser (LWC/Flow/Object/DataPack)
  anything else        → ValueError

Requirements: POOL-07
"""
from pathlib import Path
from typing import Literal

NODEJS_EXTENSIONS: frozenset[str] = frozenset({".cls", ".trigger"})

VALID_EXTENSIONS: frozenset[str] = frozenset({
    ".cls", ".trigger", ".js",
    ".xml",
    ".html",
    ".json",
})

ParserTarget = Literal["nodejs_pool", "python_parser"]


def route_file(file_path: str) -> ParserTarget:
    """Return which parser target should handle this file.

    Args:
        file_path: Path or filename of the file to route.

    Returns:
        "nodejs_pool" for Apex files (.cls, .trigger).
        "python_parser" for LWC/XML/HTML/JSON files (.js, .xml, .html, .json).

    Raises:
        ValueError: For file types not recognized by any parser.
    """
    ext = Path(file_path).suffix.lower()
    if ext in NODEJS_EXTENSIONS:
        return "nodejs_pool"
    if ext in (VALID_EXTENSIONS - NODEJS_EXTENSIONS):
        return "python_parser"
    raise ValueError(f"No parser registered for extension '{ext}' in file: {file_path}")
