"""Synthetic metadata export generator for stress/perf benchmarks."""
from __future__ import annotations

from pathlib import Path


def generate_synthetic_export(
    output_dir: str,
    class_count: int = 1000,
    flow_count: int = 100,
) -> str:
    root = Path(output_dir).expanduser().resolve()
    classes_dir = root / "classes"
    flows_dir = root / "flows"
    objects_dir = root / "objects" / "Account" / "fields"
    classes_dir.mkdir(parents=True, exist_ok=True)
    flows_dir.mkdir(parents=True, exist_ok=True)
    objects_dir.mkdir(parents=True, exist_ok=True)

    # Minimal object + field to anchor common references.
    (root / "objects" / "Account" / "Account.object-meta.xml").write_text(
        """<?xml version="1.0" encoding="UTF-8"?>
<CustomObject xmlns="http://soap.sforce.com/2006/04/metadata">
    <fullName>Account</fullName>
    <label>Account</label>
</CustomObject>
""",
        encoding="utf-8",
    )
    (objects_dir / "Status__c.field-meta.xml").write_text(
        """<?xml version="1.0" encoding="UTF-8"?>
<CustomField xmlns="http://soap.sforce.com/2006/04/metadata">
    <fullName>Status__c</fullName>
    <label>Status</label>
    <type>Picklist</type>
    <valueSet>
        <valueSetDefinition>
            <value><fullName>Active</fullName><default>true</default><label>Active</label></value>
            <value><fullName>Inactive</fullName><default>false</default><label>Inactive</label></value>
        </valueSetDefinition>
    </valueSet>
</CustomField>
""",
        encoding="utf-8",
    )

    for i in range(1, class_count + 1):
        class_name = f"SynthService{i}"
        next_class = f"SynthService{i + 1}" if i < class_count else "SynthService1"
        (classes_dir / f"{class_name}.cls").write_text(
            f"""public with sharing class {class_name} {{
    public static Account run(Id accountId) {{
        Account a = [SELECT Id, Status__c FROM Account WHERE Id = :accountId LIMIT 1];
        a.Status__c = 'Active';
        update a;
        {next_class}.run(accountId);
        return a;
    }}
}}
""",
            encoding="utf-8",
        )

    for i in range(1, flow_count + 1):
        flow_name = f"SynthFlow{i}"
        (flows_dir / f"{flow_name}.flow-meta.xml").write_text(
            f"""<?xml version="1.0" encoding="UTF-8"?>
<Flow xmlns="http://soap.sforce.com/2006/04/metadata">
    <label>{flow_name}</label>
    <processType>Flow</processType>
    <status>Active</status>
    <recordLookups>
        <name>LookupAccount</name>
        <object>Account</object>
        <filters>
            <field>Status__c</field>
        </filters>
        <outputAssignments>
            <field>Status__c</field>
        </outputAssignments>
    </recordLookups>
</Flow>
""",
            encoding="utf-8",
        )

    return str(root)
