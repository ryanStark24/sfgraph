from __future__ import annotations

from pathlib import Path

from sfgraph.query.rules_registry import RulesRegistry


def test_rules_registry_missing_config_has_safe_defaults(tmp_path: Path):
    registry = RulesRegistry(config_path=str(tmp_path / "missing-rules.yaml"))

    assert registry.resolve_alias("Account.Status__c") == "Account.Status__c"
    assert registry.semantic_override("READS_FIELD", "context") is None
    assert registry.describe()["loaded"] is False
    assert registry.describe()["alias_count"] == 0
    assert registry.describe()["semantic_override_count"] == 0


def test_rules_registry_default_config_loads_packaged_rules():
    registry = RulesRegistry()

    assert registry.describe()["loaded"] is True
    assert registry.describe()["alias_count"] >= 1
    assert registry.resolve_alias("acct_status") == "Account.Status__c"
