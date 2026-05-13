import type { OrgId } from "@sfgraph/shared";
import type { RawMember } from "../interfaces/metadata-source.js";
import type { OrgCapabilities } from "./capabilities.js";
import { iterApex } from "./extractors/apex.js";
import { iterFlow } from "./extractors/flow.js";
import { iterIntegration } from "./extractors/integration.js";
import { iterLwc } from "./extractors/lwc.js";
import { iterObject } from "./extractors/object.js";
import { iterOmnistudio } from "./extractors/omnistudio.js";
import { iterSecurity } from "./extractors/security.js";
import { iterVlocity } from "./extractors/vlocity.js";

/** Naive sequential merge — predictable order, simpler back-pressure semantics. */
export async function* mergeAsyncIterables<T>(...iters: Array<AsyncIterable<T>>): AsyncIterable<T> {
  for (const it of iters) {
    for await (const v of it) yield v;
  }
}

export async function* bulkRetrieve(
  conn: any,
  caps: OrgCapabilities,
  _orgId: OrgId,
): AsyncIterable<RawMember> {
  const sources: Array<AsyncIterable<RawMember>> = [
    iterApex(conn),
    iterLwc(conn),
    iterFlow(conn),
    iterObject(conn),
    iterSecurity(conn),
    iterIntegration(conn),
  ];
  if (caps.vlocityCmt) sources.push(iterVlocity(conn));
  if (caps.omnistudioOncore) sources.push(iterOmnistudio(conn));
  yield* mergeAsyncIterables(...sources);
}
