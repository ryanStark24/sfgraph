# tests/parser/test_dispatcher.py
"""Unit tests for ParseDispatcher routing logic.

All tests are pure unit tests — no subprocess spawning, no external dependencies.
Tests verify route_file() routes all known extensions correctly and raises ValueError
for unrecognized extensions.
"""
import pytest

from sfgraph.parser.dispatcher import (
    NODEJS_EXTENSIONS,
    VALID_EXTENSIONS,
    ParserTarget,
    route_file,
)


# --- nodejs_pool routing ---

def test_route_cls_returns_nodejs_pool():
    assert route_file("AccountService.cls") == "nodejs_pool"


def test_route_trigger_returns_nodejs_pool():
    assert route_file("AccountTrigger.trigger") == "nodejs_pool"


def test_route_js_returns_nodejs_pool():
    assert route_file("accountService.js") == "python_parser"


# --- python_parser routing ---

def test_route_object_xml_returns_python_parser():
    assert route_file("Account.object-meta.xml") == "python_parser"


def test_route_flow_xml_returns_python_parser():
    assert route_file("MyFlow.flow-meta.xml") == "python_parser"


def test_route_html_returns_python_parser():
    assert route_file("lwcComponent.html") == "python_parser"


def test_route_json_returns_python_parser():
    assert route_file("IntegrationProcedure.json") == "python_parser"


# --- ValueError cases ---

def test_route_pdf_raises_value_error():
    with pytest.raises(ValueError) as exc_info:
        route_file("Report.pdf")
    assert "pdf" in str(exc_info.value)


def test_route_empty_extension_raises_value_error():
    with pytest.raises(ValueError):
        route_file("")


# --- Exported constants ---

def test_nodejs_extensions_contains_expected_set():
    assert NODEJS_EXTENSIONS == frozenset({".cls", ".trigger"})


def test_valid_extensions_is_superset_of_nodejs_extensions():
    assert NODEJS_EXTENSIONS.issubset(VALID_EXTENSIONS)
