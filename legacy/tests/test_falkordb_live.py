# tests/test_falkordb_live.py
"""
Live integration smoke tests for FalkorDBStore.

These tests require a running FalkorDB server on localhost:6379.
Start one with: docker compose -f docker-compose.test.yml up -d

All tests are marked @pytest.mark.integration and skip gracefully
when no server is reachable — they never fail due to missing infrastructure.
"""
import asyncio
import pytest
from uuid import uuid4
from sfgraph.storage.falkordb_store import FalkorDBStore


@pytest.fixture
async def live_store():
    """
    Connect to a real FalkorDB server. Skip the test if the server
    is not reachable — this is infrastructure-optional, not a test failure.
    Uses a unique graph name per fixture invocation to prevent cross-test pollution.
    """
    import socket as _socket

    # Probe first — skip cleanly before any FalkorDB client state is created.
    # Raising pytest.skip() outside a try/except avoids chained-exception confusion.
    try:
        s = _socket.create_connection(("localhost", 6379), timeout=1)
        s.close()
    except OSError:
        pytest.skip("FalkorDB server not available on localhost:6379")

    graph_name = f"test_live_{uuid4().hex[:8]}"
    store = FalkorDBStore(host="localhost", port=6379, graph_name=graph_name)
    await store.start()
    yield store
    try:
        await store.close()
    except Exception:
        pass  # Best-effort cleanup


@pytest.mark.integration
async def test_live_merge_and_query_round_trip(live_store: FalkorDBStore):
    """
    Proves that FalkorDBStore can MERGE a node into a real FalkorDB graph
    and retrieve it via a Cypher query — no mocks involved.
    This satisfies Phase 1 ROADMAP success criterion 2 (live round-trip).
    """
    qn = await live_store.merge_node(
        "ApexClass",
        {"qualifiedName": "LiveTestClass"},
        {"qualifiedName": "LiveTestClass", "name": "LiveTestClass", "isTest": False},
    )
    assert qn == "LiveTestClass", f"merge_node must return the qualifiedName; got {qn!r}"

    results = await live_store.query(
        "MATCH (n:ApexClass {qualifiedName: $qn}) RETURN n.name AS name",
        {"qn": "LiveTestClass"},
    )
    assert len(results) == 1, f"Expected exactly 1 result; got {len(results)}"
    assert results[0]["name"] == "LiveTestClass", (
        f"Expected name='LiveTestClass'; got {results[0]['name']!r}"
    )


@pytest.mark.integration
async def test_live_concurrent_writes_do_not_corrupt(live_store: FalkorDBStore):
    """
    Proves the asyncio write queue serializes concurrent MERGE operations
    correctly against a real FalkorDB server — 20 tasks, 20 nodes, no corruption.
    This satisfies Phase 1 ROADMAP success criterion 2 (concurrent write safety).
    """
    count = 20
    tasks = [
        live_store.merge_node(
            "ApexClass",
            {"qualifiedName": f"LiveConcurrent{i}"},
            {"qualifiedName": f"LiveConcurrent{i}", "name": f"LiveConcurrent{i}"},
        )
        for i in range(count)
    ]
    await asyncio.gather(*tasks)

    results = await live_store.query(
        "MATCH (n:ApexClass) WHERE n.qualifiedName STARTS WITH 'LiveConcurrent' RETURN count(n) AS cnt"
    )
    actual = results[0]["cnt"]
    assert actual == count, (
        f"Expected {count} concurrent nodes; got {actual}. "
        "Write queue may have dropped or duplicated operations."
    )
