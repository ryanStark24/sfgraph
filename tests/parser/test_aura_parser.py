from __future__ import annotations

from sfgraph.parser.aura_parser import parse_aura_file


def test_parse_aura_component_extracts_controller_and_children(tmp_path):
    file_path = tmp_path / "force-app" / "main" / "default" / "aura" / "ParentCard" / "ParentCard.cmp"
    file_path.parent.mkdir(parents=True, exist_ok=True)
    file_path.write_text(
        """
        <aura:component controller="AccountAuraController">
            <c:ChildCard />
            <c:HelperPanel />
            <c:ChildCard />
        </aura:component>
        """,
        encoding="utf-8",
    )

    nodes, edges = parse_aura_file(str(file_path))

    assert len(nodes) == 1
    assert nodes[0].label == "AuraComponent"
    assert nodes[0].key_props["qualifiedName"] == "ParentCard"

    assert any(
        edge.rel_type == "IMPORTS_APEX"
        and edge.dst_label == "ApexClass"
        and edge.dst_qualified_name == "AccountAuraController"
        for edge in edges
    )
    children = {
        edge.dst_qualified_name
        for edge in edges
        if edge.rel_type == "CONTAINS_CHILD" and edge.dst_label == "AuraComponent"
    }
    assert children == {"ChildCard", "HelperPanel"}


def test_parse_aura_component_without_controller_is_still_indexed(tmp_path):
    file_path = tmp_path / "force-app" / "main" / "default" / "aura" / "SimpleBanner" / "SimpleBanner.app"
    file_path.parent.mkdir(parents=True, exist_ok=True)
    file_path.write_text("<aura:application><div>Hello</div></aura:application>", encoding="utf-8")

    nodes, edges = parse_aura_file(str(file_path))

    assert len(nodes) == 1
    assert nodes[0].key_props["qualifiedName"] == "SimpleBanner"
    assert edges == []
