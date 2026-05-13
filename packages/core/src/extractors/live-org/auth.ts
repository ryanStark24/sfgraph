import { ErrorCode, SfgraphError, asOrgId } from "@sfgraph/shared";
import type { OrgId } from "@sfgraph/shared";
import { wrapConnectionReadOnly } from "./read-only-proxy.js";

export interface ResolvedOrg {
  orgId: OrgId;
  alias: string;
  username: string;
  instanceUrl: string;
  apiVersion: string;
  conn: any;
}

/** Strip secrets from anything that might be logged/persisted. */
export function safeOrgInfo<T extends Record<string, unknown>>(info: T): Omit<T, "accessToken"> {
  const { accessToken: _ignored, ...rest } = info as T & { accessToken?: string };
  return rest;
}

export interface ResolveOrgDeps {
  AuthInfo?: any;
  Connection?: any;
}

/**
 * Resolve a Salesforce org by alias/username using @salesforce/core. Returns a
 * read-only-wrapped jsforce Connection.
 *
 * @throws SfgraphError with code E_SF_AUTH on authentication failures.
 */
export async function resolveOrg(alias: string, deps: ResolveOrgDeps = {}): Promise<ResolvedOrg> {
  if (!alias || typeof alias !== "string") {
    throw new SfgraphError(
      ErrorCode.E_SF_AUTH,
      `resolveOrg: invalid alias ${JSON.stringify(alias)}`,
    );
  }
  let AuthInfo: any = deps.AuthInfo;
  let Connection: any = deps.Connection;
  if (!AuthInfo || !Connection) {
    try {
      const sfCore = await import("@salesforce/core");
      AuthInfo = AuthInfo ?? sfCore.AuthInfo;
      Connection = Connection ?? sfCore.Connection;
    } catch (e) {
      throw new SfgraphError(
        ErrorCode.E_SF_AUTH,
        `resolveOrg: failed to load @salesforce/core for alias '${alias}': ${(e as Error).message}`,
        { cause: e as Error },
      );
    }
  }
  let authInfo: any;
  try {
    authInfo = await AuthInfo.create({ username: alias });
  } catch (e) {
    throw new SfgraphError(
      ErrorCode.E_SF_AUTH,
      `resolveOrg: AuthInfo.create failed for alias '${alias}'. Run 'sf org login web --alias ${alias}' to authenticate. Cause: ${(e as Error).message}`,
      { cause: e as Error },
    );
  }
  let rawConn: any;
  try {
    rawConn = await Connection.create({ authInfo });
  } catch (e) {
    throw new SfgraphError(
      ErrorCode.E_SF_AUTH,
      `resolveOrg: Connection.create failed for alias '${alias}': ${(e as Error).message}`,
      { cause: e as Error },
    );
  }
  const fields = typeof authInfo.getFields === "function" ? authInfo.getFields() : {};
  const username: string = fields.username ?? alias;
  const orgIdRaw: string = fields.orgId ?? rawConn.userInfo?.organizationId ?? `unknown_${alias}`;
  const instanceUrl: string = rawConn.instanceUrl ?? fields.instanceUrl ?? "";
  const apiVersion: string = rawConn.version ?? rawConn.getApiVersion?.() ?? "60.0";
  const conn = wrapConnectionReadOnly(rawConn);
  return {
    orgId: asOrgId(orgIdRaw),
    alias,
    username,
    instanceUrl,
    apiVersion,
    conn,
  };
}

export { wrapConnectionReadOnly };

/**
 * Resolve the default org alias for the current process. Reads `target-org`
 * (sfdx-style `defaultusername` is also accepted) from the @salesforce/core
 * ConfigAggregator, which transparently merges local `.sf/config.json`,
 * project `sfdx-project.json`, and global `~/.sf/config.json`.
 *
 * @returns the resolved alias/username string, or `null` if none configured.
 */
export async function resolveDefaultOrgAlias(
  deps: {
    ConfigAggregator?: any;
  } = {},
): Promise<string | null> {
  let ConfigAggregator: any = deps.ConfigAggregator;
  if (!ConfigAggregator) {
    try {
      const sfCore = await import("@salesforce/core");
      ConfigAggregator = sfCore.ConfigAggregator;
    } catch {
      return null;
    }
  }
  try {
    const aggregator = await ConfigAggregator.create();
    const info =
      aggregator.getInfo?.("target-org") ?? aggregator.getInfo?.("defaultusername") ?? null;
    const value = info?.value;
    if (typeof value === "string" && value.length > 0) return value;
    return null;
  } catch {
    return null;
  }
}
