import { METADATA_CATEGORY, type MetadataCategory } from "../../../domain/index.js";
import type { RawMember } from "../../interfaces/metadata-source.js";
import { scheduleQuery } from "../rate-limit.js";

interface ORow {
  Id?: string;
  Name?: string;
  DeveloperName?: string;
  LastModifiedDate?: string;
  [k: string]: unknown;
}

interface OQuery {
  memberType: string;
  category: MetadataCategory;
  soql: string;
}

const QUERIES: OQuery[] = [
  {
    memberType: "OmniProcess",
    category: METADATA_CATEGORY.OMNI_PROCESS,
    soql: "SELECT Id, Name, OmniProcessType, LastModifiedDate FROM OmniProcess",
  },
  {
    memberType: "OmniDataTransform",
    category: METADATA_CATEGORY.OMNI_DATA_TRANSFORM,
    soql: "SELECT Id, Name, OmniDataTransformType, LastModifiedDate FROM OmniDataTransform",
  },
  {
    memberType: "OmniUiCard",
    category: METADATA_CATEGORY.OMNI_UI_CARD,
    soql: "SELECT Id, DeveloperName, LastModifiedDate FROM OmniUiCard",
  },
  {
    memberType: "OmniIntegrationProcedure",
    category: METADATA_CATEGORY.OMNI_INTEGRATION_PROCEDURE,
    soql: "SELECT Id, Name, LastModifiedDate FROM OmniProcess WHERE OmniProcessType = 'Integration Procedure'",
  },
];

export async function* iterOmnistudio(conn: any): AsyncIterable<RawMember> {
  for (const q of QUERIES) {
    let res: { records?: ORow[] } | null = null;
    try {
      res = (await scheduleQuery(() => conn.tooling.query(q.soql))) as { records?: ORow[] } | null;
    } catch {
      continue;
    }
    for (const r of res?.records ?? []) {
      const name = String(r.DeveloperName ?? r.Name ?? r.Id ?? "");
      yield {
        ref: {
          category: q.category,
          memberType: q.memberType,
          memberName: name,
          lastModifiedAt: r.LastModifiedDate ?? null,
          sourceUri: `sf://omnistudio/${q.memberType}/${name}`,
          namespace: null,
        },
        content: JSON.stringify(r),
      };
    }
  }
}
