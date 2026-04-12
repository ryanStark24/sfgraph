from pathlib import Path

from sfgraph.parser.metadata_parser import parse_named_credential_xml, parse_permission_metadata_xml


def test_parse_permission_set_xml(tmp_path: Path):
    path = tmp_path / 'Support.permissionset-meta.xml'
    path.write_text(
        """<?xml version=\"1.0\" encoding=\"UTF-8\"?>
<PermissionSet xmlns=\"http://soap.sforce.com/2006/04/metadata\">
    <label>Support</label>
    <description>Support access</description>
    <objectPermissions>
        <object>Case</object>
        <allowRead>true</allowRead>
        <allowEdit>true</allowEdit>
    </objectPermissions>
    <fieldPermissions>
        <field>Case.Status</field>
        <readable>true</readable>
        <editable>false</editable>
    </fieldPermissions>
    <classAccesses>
        <apexClass>CaseService</apexClass>
        <enabled>true</enabled>
    </classAccesses>
</PermissionSet>""",
        encoding='utf-8',
    )

    nodes, edges = parse_permission_metadata_xml(str(path))
    assert any(n.label == 'PermissionSet' and n.key_props['qualifiedName'] == 'Support' for n in nodes)
    assert any(e.rel_type == 'GRANTS_OBJECT_ACCESS' and e.dst_qualified_name == 'Case' for e in edges)
    assert any(e.rel_type == 'GRANTS_FIELD_ACCESS' and e.dst_qualified_name == 'Case.Status' for e in edges)
    assert any(e.rel_type == 'GRANTS_APEX_ACCESS' and e.dst_qualified_name == 'CaseService' for e in edges)


def test_parse_profile_xml(tmp_path: Path):
    path = tmp_path / 'System Administrator.profile-meta.xml'
    path.write_text(
        """<?xml version=\"1.0\" encoding=\"UTF-8\"?>
<Profile xmlns=\"http://soap.sforce.com/2006/04/metadata\">
    <userPermissions>
        <enabled>true</enabled>
        <name>ViewAllData</name>
    </userPermissions>
    <fieldPermissions>
        <field>Account.Status__c</field>
        <readable>true</readable>
        <editable>true</editable>
    </fieldPermissions>
</Profile>""",
        encoding='utf-8',
    )

    nodes, edges = parse_permission_metadata_xml(str(path))
    assert any(n.label == 'Profile' and n.key_props['qualifiedName'] == 'System Administrator' for n in nodes)
    assert any(e.rel_type == 'GRANTS_FIELD_ACCESS' and e.dst_qualified_name == 'Account.Status__c' for e in edges)


def test_parse_named_credential_xml(tmp_path: Path):
    path = tmp_path / 'BillingApi.namedCredential-meta.xml'
    path.write_text(
        """<?xml version=\"1.0\" encoding=\"UTF-8\"?>
<NamedCredential xmlns=\"http://soap.sforce.com/2006/04/metadata\">
    <label>Billing API</label>
    <endpoint>https://billing.example.com/v1</endpoint>
    <externalCredential>BillingExternal</externalCredential>
    <protocol>SecuredEndpoint</protocol>
</NamedCredential>""",
        encoding='utf-8',
    )

    nodes, edges = parse_named_credential_xml(str(path))
    assert len(nodes) == 1
    node = nodes[0]
    assert node.label == 'NamedCredential'
    assert node.key_props['qualifiedName'] == 'BillingApi'
    assert node.all_props['endpointHost'] == 'https://billing.example.com/v1'
    assert any(e.rel_type == 'USES_EXTERNAL_CREDENTIAL' and e.dst_qualified_name == 'BillingExternal' for e in edges)
