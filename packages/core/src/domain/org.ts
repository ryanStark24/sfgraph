import type { OrgId } from "@ryanstark24/sfgraph-shared";

export interface Org {
  id: OrgId;
  alias: string;
  instanceUrl: string;
  apiVersion: string;
  createdAt: number;
  lastSyncedAt?: number | null;
}
