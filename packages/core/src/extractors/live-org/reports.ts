import type { RawMember } from "../interfaces/metadata-source.js";

/** Phase 6 placeholder — emits nothing today. */
export function iterReports(_conn: any): AsyncIterable<RawMember> {
  return emptyAsyncIterable();
}

async function* emptyAsyncIterable(): AsyncIterable<RawMember> {
  // intentional: phase-6 stub
  if (false as boolean) yield undefined as unknown as RawMember;
}
