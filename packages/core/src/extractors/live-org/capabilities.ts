export const VLOCITY_NAMESPACE_CANDIDATES = [
  "vlocity_cmt",
  "vlocity_ins",
  "vlocity_hc",
  "vlocity_ps",
  "vlocity_fs",
  // OmniStudio managed package was forked from Vlocity-CMT and ships an
  // identical SObject schema under the `omnistudio` namespace. Detecting
  // it via the same DRBundle__c probe lets the vlocity extractor pull
  // OmniScripts / Integration Procedures / DataRaptors from
  // OmniStudio-managed orgs without writing a parallel extractor.
  "omnistudio",
] as const;

export type VlocityNamespace = (typeof VLOCITY_NAMESPACE_CANDIDATES)[number];

export interface OrgCapabilities {
  detectedNamespaces: string[];
  /** Subset of VLOCITY_NAMESPACE_CANDIDATES whose `${ns}__DRBundle__c` exists. */
  vlocityNamespaces: string[];
  /** True if any Vlocity industry namespace was detected. */
  vlocityLegacy: boolean;
  /** Back-compat alias: equivalent to vlocityNamespaces.includes('vlocity_cmt'). */
  vlocityCmt: boolean;
  omnistudioOncore: boolean;
  agentforce: boolean;
  experienceCloud: boolean;
  sourceTracking: boolean;
}

// All capability probes use a SHORT 15s timeout — they're tiny single-row
// queries against well-known SObjects, and probeCapabilities is the very
// first thing every ingest does. If the connection's dead at this stage,
// we want to surface that within seconds, not hang the whole startup
// hoping for a response that's never coming.
const CAPS_PROBE_TIMEOUT_MS = 15_000;
async function withCapsTimeout<T>(p: Promise<T>, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(
      () => reject(new Error(`capabilities probe ${label} timeout (${CAPS_PROBE_TIMEOUT_MS}ms)`)),
      CAPS_PROBE_TIMEOUT_MS,
    );
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });
}

async function safeQuery(conn: any, soql: string): Promise<{ records?: unknown[] } | null> {
  try {
    return (await withCapsTimeout(conn.query(soql), `query ${soql.slice(0, 40)}`)) as {
      records?: unknown[];
    };
  } catch {
    return null;
  }
}

async function safeToolingQuery(conn: any, soql: string): Promise<{ records?: unknown[] } | null> {
  try {
    return (await withCapsTimeout(
      conn.tooling.query(soql),
      `tooling ${soql.slice(0, 40)}`,
    )) as { records?: unknown[] };
  } catch {
    return null;
  }
}

async function describeExists(conn: any, name: string, useTooling = false): Promise<boolean> {
  try {
    const root = useTooling ? conn.tooling : conn;
    await withCapsTimeout(root.sobject(name).describe(), `describe ${name}`);
    return true;
  } catch {
    return false;
  }
}

/** Probe a Salesforce org for installed packages, features, and source-tracking support. */
export async function probeCapabilities(conn: any): Promise<OrgCapabilities> {
  // Organization metadata
  await safeQuery(conn, "SELECT Id, OrganizationType, IsSandbox FROM Organization LIMIT 1");

  // Installed-package namespaces via tooling
  const namespaces: string[] = [];
  const pkgs = await safeToolingQuery(conn, "SELECT NamespacePrefix FROM PackageLicense");
  if (pkgs?.records) {
    for (const r of pkgs.records as Array<{ NamespacePrefix?: string }>) {
      if (r.NamespacePrefix) namespaces.push(r.NamespacePrefix);
    }
  }

  const vlocityProbes = await Promise.all(
    VLOCITY_NAMESPACE_CANDIDATES.map((ns) => describeExists(conn, `${ns}__DRBundle__c`)),
  );
  const vlocityNamespaces: string[] = VLOCITY_NAMESPACE_CANDIDATES.filter(
    (_ns, i) => vlocityProbes[i],
  );

  const [omnistudioOncore, agentforce, experienceCloud, sourceTracking] = await Promise.all([
    describeExists(conn, "OmniProcess"),
    describeExists(conn, "GenAiPlanner", true),
    describeExists(conn, "Network"),
    describeExists(conn, "SourceMember", true),
  ]);

  return {
    detectedNamespaces: namespaces,
    vlocityNamespaces,
    vlocityLegacy: vlocityNamespaces.length > 0,
    vlocityCmt: vlocityNamespaces.includes("vlocity_cmt"),
    omnistudioOncore,
    agentforce,
    experienceCloud,
    sourceTracking,
  };
}
