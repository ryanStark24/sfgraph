export interface OrgCapabilities {
  detectedNamespaces: string[];
  vlocityCmt: boolean;
  omnistudioOncore: boolean;
  agentforce: boolean;
  experienceCloud: boolean;
  sourceTracking: boolean;
}

async function safeQuery(conn: any, soql: string): Promise<{ records?: unknown[] } | null> {
  try {
    return (await conn.query(soql)) as { records?: unknown[] };
  } catch {
    return null;
  }
}

async function safeToolingQuery(conn: any, soql: string): Promise<{ records?: unknown[] } | null> {
  try {
    return (await conn.tooling.query(soql)) as { records?: unknown[] };
  } catch {
    return null;
  }
}

async function describeExists(conn: any, name: string, useTooling = false): Promise<boolean> {
  try {
    const root = useTooling ? conn.tooling : conn;
    await root.sobject(name).describe();
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

  const [vlocityCmt, omnistudioOncore, agentforce, experienceCloud, sourceTracking] =
    await Promise.all([
      describeExists(conn, "vlocity_cmt__DRBundle__c"),
      describeExists(conn, "OmniProcess"),
      describeExists(conn, "GenAiPlanner", true),
      describeExists(conn, "Network"),
      describeExists(conn, "SourceMember", true),
    ]);

  return {
    detectedNamespaces: namespaces,
    vlocityCmt,
    omnistudioOncore,
    agentforce,
    experienceCloud,
    sourceTracking,
  };
}
