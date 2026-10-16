import { METADATA_CATEGORY } from "../../../domain/index.js";
import type { RawMember } from "../../interfaces/metadata-source.js";
import { scheduleData, scheduleQuery, soqlWithTimeout } from "../rate-limit.js";
import {
  type FetchFailure,
  type RetryOptions,
  isOrgRejection,
  querySoqlAll,
  throwIfIncomplete,
  withRetry,
} from "../retry.js";

/**
 * Custom Settings ROW capture. Custom settings are SObjects whose rows ARE the
 * config (org-default + per-profile/user hierarchy values) — e.g. feature
 * toggles, integration endpoints, page URLs. The object schema is already
 * ingested as a CustomObject node, but its ROWS (the actual values) were never
 * captured, so tracing a path that reads a setting couldn't show what it
 * resolves to. This extractor emits a `CustomSetting:<obj>` member carrying the
 * rows; the custom-setting rule turns it into a node whose `customSettingRows`
 * attribute is folded into the embedding (buildEmbedText), making setting
 * values semantically searchable, plus a link to the CustomObject schema node.
 *
 * Treated as CONFIG metadata, not business record data — custom settings are
 * deploy-time/admin config, distinct from transactional records (out of scope).
 */

interface EntityRow {
  QualifiedApiName?: string;
}

const SYS_FIELDS = new Set([
  "Id",
  "attributes",
  "SystemModstamp",
  "CreatedById",
  "CreatedDate",
  "LastModifiedById",
  "LastModifiedDate",
  "IsDeleted",
]);

/** FIELDS(ALL) requires a row bound ≤ 200. Custom settings rarely exceed that
 *  except hierarchy settings with a row per profile/user; we cap and note it. */
const ROW_CAP = 200;

export async function* iterCustomSettings(
  conn: any,
  orgId: string,
  retryOpts: RetryOptions = {},
): AsyncIterable<RawMember> {
  let entities: EntityRow[] = [];
  try {
    // Drain every page and retry: a truncated discovery silently loses
    // custom settings.
    entities = await querySoqlAll<EntityRow>(
      conn.tooling,
      "SELECT QualifiedApiName FROM EntityDefinition WHERE IsCustomSetting = true",
      "tooling EntityDefinition IsCustomSetting",
      scheduleQuery,
      retryOpts,
    );
  } catch (e) {
    // EntityDefinition unavailable (some scratch orgs) — nothing to do.
    // Anything else (timeouts, connection loss) must surface as a skip.
    if (isOrgRejection(e)) return;
    throw e;
  }
  const failures: FetchFailure[] = [];

  for (const ent of entities) {
    const obj = ent.QualifiedApiName;
    if (!obj) continue;
    let rows: Array<Record<string, unknown>> = [];
    try {
      // LIMIT ROW_CAP (200) fits in one page, so no queryMore needed.
      const res = (await withRetry(
        () =>
          scheduleData(() =>
            soqlWithTimeout(
              conn.query(`SELECT FIELDS(ALL) FROM ${obj} LIMIT ${ROW_CAP}`),
              `data ${obj} (custom-setting rows)`,
            ),
          ),
        retryOpts,
      )) as { records?: Array<Record<string, unknown>> } | null;
      rows = res?.records ?? [];
    } catch (e) {
      // Inaccessible / non-queryable objects have no rows to capture; the
      // schema node still exists from the object extractor. Transient
      // failures are recorded and surfaced after the loop.
      if (!isOrgRejection(e)) failures.push({ name: obj, error: e });
      continue;
    }
    if (rows.length === 0) continue;
    // Strip system/audit fields — keep the config-bearing columns only.
    const cleaned = rows.map((r) => {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(r)) {
        if (SYS_FIELDS.has(k) || v === null || v === "") continue;
        out[k] = v;
      }
      return out;
    });
    yield {
      ref: {
        category: METADATA_CATEGORY.CUSTOM_SETTING,
        memberType: "CustomSetting",
        memberName: obj,
        lastModifiedAt: null,
        sourceUri: `sf://${orgId}/CustomSetting/${obj}`,
        namespace: null,
      },
      content: JSON.stringify({ name: obj, rows: cleaned, rowCount: rows.length }),
    };
  }
  throwIfIncomplete("custom-settings", failures);
}
