import { XMLBuilder } from "fast-xml-parser";
import { METADATA_CATEGORY } from "../../../domain/index.js";
import type { RawMember } from "../../interfaces/metadata-source.js";
import { scheduleMetadata } from "../rate-limit.js";

const BATCH = 10;
const xml = new XMLBuilder({
  ignoreAttributes: false,
  format: false,
  suppressEmptyNode: true,
});

interface MdListItem {
  fullName: string;
  lastModifiedDate?: string;
  namespacePrefix?: string;
}

/**
 * Was scheduleQuery (Tooling pool). conn.metadata.list/read are Metadata API,
 * not Tooling — so this had been routing Flow reads through the wrong budget
 * and competing with Apex SOQL. Now correctly on the Metadata pool, and all
 * batches fire in parallel (Bottleneck throttles to maxConcurrent).
 */
export async function* iterFlow(conn: any): AsyncIterable<RawMember> {
  const list = (await scheduleMetadata(() =>
    conn.metadata.list([{ type: "Flow" }]),
  )) as MdListItem[] | null;
  const items = Array.isArray(list) ? list : [];
  const batches: MdListItem[][] = [];
  for (let i = 0; i < items.length; i += BATCH) batches.push(items.slice(i, i + BATCH));
  const batchResults = await Promise.all(
    batches.map((slice) =>
      scheduleMetadata(() =>
        conn.metadata.read(
          "Flow",
          slice.map((s) => s.fullName),
        ),
      ),
    ),
  );
  for (let b = 0; b < batches.length; b++) {
    const slice = batches[b];
    if (!slice) continue;
    const reads = batchResults[b];
    const readArr = Array.isArray(reads) ? reads : [reads];
    for (let j = 0; j < slice.length; j += 1) {
      const meta = slice[j];
      if (!meta) continue;
      const obj = readArr[j] ?? {};
      const content = xml.build({ Flow: obj });
      yield {
        ref: {
          category: METADATA_CATEGORY.FLOW,
          memberType: "Flow",
          memberName: meta.fullName,
          lastModifiedAt: meta.lastModifiedDate ?? null,
          sourceUri: `sf://metadata/Flow/${meta.fullName}`,
          namespace: meta.namespacePrefix ?? null,
        },
        content: typeof content === "string" ? content : String(content),
      };
    }
  }
}
