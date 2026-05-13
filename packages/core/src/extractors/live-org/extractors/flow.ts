import { XMLBuilder } from "fast-xml-parser";
import { METADATA_CATEGORY } from "../../../domain/index.js";
import type { RawMember } from "../../interfaces/metadata-source.js";
import { scheduleQuery } from "../rate-limit.js";

const BATCH = 10;
const xml = new XMLBuilder({
  ignoreAttributes: false,
  format: false,
  suppressEmptyNode: true,
});

export async function* iterFlow(conn: any): AsyncIterable<RawMember> {
  const list = (await scheduleQuery(() => conn.metadata.list([{ type: "Flow" }]))) as Array<{
    fullName: string;
    lastModifiedDate?: string;
    namespacePrefix?: string;
  }> | null;
  const items = Array.isArray(list) ? list : [];
  for (let i = 0; i < items.length; i += BATCH) {
    const slice = items.slice(i, i + BATCH);
    const names = slice.map((s) => s.fullName);
    const reads = (await scheduleQuery(() => conn.metadata.read("Flow", names))) as any;
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
