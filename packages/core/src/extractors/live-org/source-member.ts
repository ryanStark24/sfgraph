import type { OrgId } from "@ryanstark24/sfgraph-shared";
import { METADATA_CATEGORY, type MetadataCategory } from "../../domain/index.js";
import type { MemberRef } from "../interfaces/metadata-source.js";
import { scheduleQuery } from "./rate-limit.js";

interface SourceMemberRow {
  Id: string;
  MemberType: string;
  MemberName: string;
  RevisionCounter: number;
  IsNameObsolete: boolean;
  LastModifiedDate: string;
}

const MEMBER_TYPE_TO_CATEGORY: Record<string, MetadataCategory> = {
  ApexClass: METADATA_CATEGORY.APEX_CLASS,
  ApexTrigger: METADATA_CATEGORY.APEX_TRIGGER,
  ApexPage: METADATA_CATEGORY.APEX_PAGE,
  ApexComponent: METADATA_CATEGORY.APEX_COMPONENT,
  LightningComponentBundle: METADATA_CATEGORY.LWC,
  AuraDefinitionBundle: METADATA_CATEGORY.AURA,
  Flow: METADATA_CATEGORY.FLOW,
  CustomObject: METADATA_CATEGORY.OBJECT,
  CustomField: METADATA_CATEGORY.FIELD,
  Profile: METADATA_CATEGORY.PROFILE,
  PermissionSet: METADATA_CATEGORY.PERMISSION_SET,
  NamedCredential: METADATA_CATEGORY.NAMED_CREDENTIAL,
};

/**
 * Iterate over Salesforce Tooling SourceMember rows modified after `sinceIso`.
 * Deletions surface with `obsolete: true` and an empty source URI suffix.
 */
export async function* iterChanges(
  conn: any,
  _orgId: OrgId,
  sinceIso: string,
): AsyncIterable<MemberRef> {
  // Salesforce SOQL datetime literals are unquoted ISO-8601 (e.g. 2025-01-01T00:00:00Z).
  const since = sinceIso.replace(/'/g, "");
  const baseSoql = `SELECT Id, MemberType, MemberName, RevisionCounter, IsNameObsolete, LastModifiedDate FROM SourceMember WHERE LastModifiedDate > ${since} ORDER BY LastModifiedDate ASC`;

  let result: any = await scheduleQuery(() => conn.tooling.query(baseSoql));
  while (result) {
    const records = (result.records ?? []) as SourceMemberRow[];
    for (const r of records) {
      const category = MEMBER_TYPE_TO_CATEGORY[r.MemberType];
      if (!category) continue;
      yield {
        category,
        memberType: r.MemberType,
        memberName: r.MemberName,
        lastModifiedAt: r.LastModifiedDate,
        sourceUri: `sf://tooling/${r.MemberType}/${r.MemberName}`,
        obsolete: Boolean(r.IsNameObsolete),
      };
    }
    if (result.done || !result.nextRecordsUrl || typeof conn.tooling.queryMore !== "function") {
      break;
    }
    result = await scheduleQuery(() => conn.tooling.queryMore(result.nextRecordsUrl));
  }
}
