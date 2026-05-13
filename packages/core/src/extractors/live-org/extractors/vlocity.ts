import { METADATA_CATEGORY, type MetadataCategory } from "../../../domain/index.js";
import type { RawMember } from "../../interfaces/metadata-source.js";
import { scheduleQuery } from "../rate-limit.js";

interface VRow {
  Id?: string;
  Name?: string;
  LastModifiedDate?: string;
  [k: string]: unknown;
}

interface VQuery {
  memberType: string;
  category: MetadataCategory;
  soql: string;
  nameField: string;
}

const QUERIES: VQuery[] = [
  {
    memberType: "VlocityDataRaptor",
    category: METADATA_CATEGORY.VLOCITY_DATARAPTOR,
    soql: "SELECT Id, Name, vlocity_cmt__Type__c, vlocity_cmt__InterfaceSourceType__c, LastModifiedDate FROM vlocity_cmt__DRBundle__c",
    nameField: "Name",
  },
  {
    memberType: "VlocityIntegrationProcedure",
    category: METADATA_CATEGORY.VLOCITY_INTEGRATION_PROCEDURE,
    soql: "SELECT Id, Name, vlocity_cmt__ProcedureKey__c, vlocity_cmt__Content__c, LastModifiedDate FROM vlocity_cmt__OmniScript__c WHERE vlocity_cmt__IsProcedure__c = true",
    nameField: "Name",
  },
  {
    memberType: "VlocityOmniScript",
    category: METADATA_CATEGORY.VLOCITY_OMNISCRIPT,
    soql: "SELECT Id, Name, vlocity_cmt__Type__c, vlocity_cmt__SubType__c, vlocity_cmt__Content__c, LastModifiedDate FROM vlocity_cmt__OmniScript__c WHERE vlocity_cmt__IsProcedure__c = false",
    nameField: "Name",
  },
  {
    memberType: "VlocityCard",
    category: METADATA_CATEGORY.VLOCITY_CARD,
    soql: "SELECT Id, Name, vlocity_cmt__Definition__c, LastModifiedDate FROM vlocity_cmt__VlocityCard__c",
    nameField: "Name",
  },
];

export async function* iterVlocity(conn: any): AsyncIterable<RawMember> {
  for (const q of QUERIES) {
    let res: { records?: VRow[] } | null = null;
    try {
      res = (await scheduleQuery(() => conn.query(q.soql))) as { records?: VRow[] } | null;
    } catch {
      continue;
    }
    for (const r of res?.records ?? []) {
      const name = String(r[q.nameField] ?? r.Name ?? r.Id ?? "");
      yield {
        ref: {
          category: q.category,
          memberType: q.memberType,
          memberName: name,
          lastModifiedAt: r.LastModifiedDate ?? null,
          sourceUri: `sf://vlocity/${q.memberType}/${name}`,
          namespace: "vlocity_cmt",
        },
        content: JSON.stringify(r),
      };
    }
  }
}
