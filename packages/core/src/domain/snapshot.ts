import type { OrgId } from "@sfgraph/shared";

export interface Snapshot {
  id: string;
  orgId: OrgId;
  label: string;
  createdAt: number;
  isAuto: boolean;
}
