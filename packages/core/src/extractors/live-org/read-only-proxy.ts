import { createReadFacade } from "./read-facade.js";
import type { ReadOnlyOrgConnection } from "./read-facade.js";
import { installTransportGuard } from "./transport-guard.js";

/**
 * Make a Salesforce connection read-only for extractors.
 *
 * Two layers:
 *  1. `installTransportGuard` refuses every non-GET/HEAD request on the raw
 *     connection's transport, except Metadata API SOAP read operations.
 *  2. `createReadFacade` returns a typed object exposing only the read calls
 *     sfgraph uses. The raw connection is private to its closures.
 *
 * The name is kept for existing callers; it no longer returns a Proxy.
 */
export function wrapConnectionReadOnly(conn: unknown): ReadOnlyOrgConnection {
  installTransportGuard(conn);
  return createReadFacade(conn);
}
