"""Runtime policy helpers for privacy-preserving defaults."""
from __future__ import annotations

import os


def network_allowed() -> bool:
    """Return True only when outbound network use is explicitly enabled."""
    return os.getenv("SFGRAPH_ALLOW_NETWORK", "0") in {"1", "true", "True"}
