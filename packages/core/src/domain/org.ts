import type { OrgId } from "@sfgraph/shared";

export interface Org {
  id: OrgId;
  alias: string;
  instanceUrl: string;
  apiVersion: string;
  createdAt: number;
}
