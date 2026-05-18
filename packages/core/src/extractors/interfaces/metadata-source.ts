import type { MetadataCategory } from "../../domain/index.js";

export interface MemberRef {
  category: MetadataCategory;
  memberType: string;
  memberName: string;
  lastModifiedAt: string | null;
  sourceUri: string;
  /** Set true for incremental deletions (SourceMember.IsNameObsolete = true). */
  obsolete?: boolean;
  /** Optional namespace prefix (e.g. "vlocity_cmt"). */
  namespace?: string | null;
}

export interface RawMember {
  ref: MemberRef;
  /** Serialized content for the parser (XML / JSON / source). May be empty for deletions. */
  content: string;
  /**
   * Optional per-record metadata flags emitted by the bulk-retrieve fan-out.
   * Today only `lateYield` is defined: it marks records that were yielded by
   * a wedged source AFTER its sliding-window slot was released by the watchdog
   * (i.e., drained from the background-wedge set rather than the live merger).
   * Downstream parsers/upserts are idempotent and ignore this flag; it exists
   * for telemetry + tests asserting late-drain behavior. See Phase 1.5 W1.5-02.
   */
  attributes?: {
    lateYield?: boolean;
  };
}

export interface MetadataSource {
  iter(): AsyncIterable<RawMember>;
}
