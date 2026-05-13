import type { OrgId } from "@ryanstark24/sfgraph-shared";

export interface Snapshot {
  id: string;
  orgId: OrgId;
  label: string;
  createdAt: number;
  isAuto: boolean;
}
