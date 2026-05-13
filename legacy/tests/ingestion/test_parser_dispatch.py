from pathlib import Path

from sfgraph.ingestion.parser_dispatch import is_supported_source_file, parser_name_for_file


def test_parser_name_for_supported_salesforce_files():
    assert parser_name_for_file(Path('force-app/main/default/classes/AccountService.cls')) == 'apex'
    assert parser_name_for_file(Path('force-app/main/default/aura/MyCmp/MyCmp.cmp')) == 'aura'
    assert parser_name_for_file(Path('force-app/main/default/lwc/myCmp/myCmp.js')) == 'lwc'
    assert parser_name_for_file(Path('force-app/main/default/flows/Sync.flow-meta.xml')) == 'flow'
    assert parser_name_for_file(Path('force-app/main/default/objects/Case/Case.workflow-meta.xml')) == 'object'
    assert parser_name_for_file(Path('force-app/main/default/reports/Sales/Pipeline.report-meta.xml')) == 'object'
    assert parser_name_for_file(Path('force-app/main/default/dashboards/Exec/Ops.dashboard-meta.xml')) == 'object'


def test_is_supported_source_file_for_metadata_and_vlocity():
    assert is_supported_source_file(Path('force-app/main/default/namedCredentials/Billing.namedCredential-meta.xml')) is True
    assert is_supported_source_file(Path('force-app/main/default/permissionsets/Support.permissionset-meta.xml')) is True
    assert is_supported_source_file(Path('vlocity/IntegrationProcedure/MyIP/MyIP_DataPack.json')) is True
    assert is_supported_source_file(Path('package.json')) is False
