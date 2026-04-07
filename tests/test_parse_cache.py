from sfgraph.storage.parse_cache import ParseCache


async def test_parse_cache_round_trip(tmp_path):
    cache = ParseCache(str(tmp_path / "parse_cache.sqlite"))
    await cache.initialize()
    try:
        payload = {"nodes": [{"label": "ApexClass"}], "edges": []}
        await cache.put("apex", "deadbeef", payload)
        stored = await cache.get("apex", "deadbeef")
        assert stored == payload
    finally:
        await cache.close()
