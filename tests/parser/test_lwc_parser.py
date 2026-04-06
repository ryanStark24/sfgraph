"""Tests for LWC parser requirements LWC-01 through LWC-06."""
from __future__ import annotations

from pathlib import Path

import pytest

from sfgraph.ingestion.constants import EDGE_CATEGORIES
from sfgraph.parser.lwc_parser import LWCParser, parse_lwc_file


@pytest.fixture
def lwc_bundle(tmp_path):
    bundle = tmp_path / "accountPanel"
    bundle.mkdir()

    js = bundle / "accountPanel.js"
    js.write_text(
        """
import { LightningElement, wire } from 'lwc';
import getContacts from '@salesforce/apex/ContactController.getContacts';
import updateStatus from '@salesforce/apex/AccountService.updateStatus';
import STATUS_LABEL from '@salesforce/label/c.Account_Status_Label';
import NAME_FIELD from '@salesforce/schema/Account.Name';
import STATUS_FIELD from '@salesforce/schema/Account.Status__c';
import { getRecord } from 'lightning/uiRecordApi';

export default class AccountPanel extends LightningElement {
  @wire(getContacts) contacts;
  @wire(getRecord, { recordId: '$recordId', fields: [NAME_FIELD, STATUS_FIELD] }) account;

  handleClick() {
    updateStatus({ id: this.recordId });
    return STATUS_LABEL;
  }
}
""",
        encoding="utf-8",
    )

    html = bundle / "accountPanel.html"
    html.write_text(
        """
<template>
  <c-contact-list></c-contact-list>
  <lightning-record-form object-api-name="Account" fields="Name,Status__c"></lightning-record-form>
</template>
""",
        encoding="utf-8",
    )

    return bundle, js, html


def test_lwc_js_imports_apex_wire_and_imperative(lwc_bundle):
    _, js, _ = lwc_bundle
    _, edges = parse_lwc_file(str(js))
    imports = [e for e in edges if e.rel_type == "IMPORTS_APEX"]
    assert imports
    assert any("callType=wire" in e.contextSnippet for e in imports)
    assert any("callType=imperative" in e.contextSnippet for e in imports)
    assert any(e.dst_qualified_name == "ContactController.getContacts" for e in imports)
    assert any(e.dst_qualified_name == "AccountService.updateStatus" for e in imports)


def test_lwc_js_label_resolution(lwc_bundle):
    _, js, _ = lwc_bundle
    _, edges = parse_lwc_file(str(js))
    label_edges = [e for e in edges if e.rel_type == "LWC_RESOLVES_LABEL"]
    assert label_edges
    assert any(e.dst_qualified_name == "CustomLabel.Account_Status_Label" for e in label_edges)


def test_lwc_js_getrecord_field_wiring(lwc_bundle):
    _, js, _ = lwc_bundle
    _, edges = parse_lwc_file(str(js))
    adapter_edges = [e for e in edges if e.rel_type == "WIRES_ADAPTER"]
    assert adapter_edges
    dst = {e.dst_qualified_name for e in adapter_edges}
    assert "Account.Name" in dst
    assert "Account.Status__c" in dst


def test_lwc_html_child_component_and_record_form(lwc_bundle):
    _, _, html = lwc_bundle
    _, edges = parse_lwc_file(str(html))
    child_edges = [e for e in edges if e.rel_type == "CONTAINS_CHILD"]
    assert child_edges
    assert any(e.dst_qualified_name == "contact-list" for e in child_edges)

    adapter_edges = [e for e in edges if e.rel_type == "WIRES_ADAPTER"]
    assert adapter_edges
    dst = {e.dst_qualified_name for e in adapter_edges}
    assert "Account.Name" in dst
    assert "Account.Status__c" in dst


def test_lwc_nodes_have_source_attribution(lwc_bundle):
    bundle, _, _ = lwc_bundle
    parser = LWCParser()
    nodes, _ = parser.parse_lwc_dir(str(bundle))
    assert nodes
    for node in nodes:
        assert node.label == "LWCComponent"
        assert node.sourceFile
        assert node.parserType in {"lwc_js", "lwc_html"}
        assert "sourceFile" in node.all_props
        assert "lastIngestedAt" in node.all_props


def test_all_edge_categories_valid(lwc_bundle):
    bundle, _, _ = lwc_bundle
    parser = LWCParser()
    _, edges = parser.parse_lwc_dir(str(bundle))
    assert edges
    for edge in edges:
        assert edge.edgeCategory in EDGE_CATEGORIES
