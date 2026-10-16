import { type EdgeFact, REL_TYPES } from "../../domain/index.js";
import type { ParseContext } from "../contract.js";
import { classifyElement, collectRefEdges } from "../vlocity/common.js";

/**
 * Remote / HTTP actions of a native OmniStudio component (OmniProcess,
 * Omni IP, OmniUiCard), via the shared Vlocity classifier: a Remote Action
 * names its Apex class (`Remote:<remoteClass>` + remoteMethod, which the
 * vlocity-apex resolver binds) and an HTTP action with a Named Credential
 * links to it. One edge per (rel, dst); every remote method is kept.
 */
export function omniRemoteEdges(md: unknown, ctx: ParseContext, src: string): EdgeFact[] {
  return collectRefEdges(
    md,
    ctx,
    src,
    (v) => classifyElement(v).filter((r) => r.kind === "remote" || r.kind === "rest"),
    (kind) =>
      kind === "remote"
        ? REL_TYPES.OMNI_INVOKES_REMOTE
        : kind === "rest"
          ? REL_TYPES.CALLS_NAMED_CREDENTIAL
          : undefined,
  );
}
