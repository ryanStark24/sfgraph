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
  /**
   * Task 11c: cheap change signal for this member (sizes + mtimes of its
   * files), set by sources that support delta ingest. Equal fingerprints
   * mean "unchanged" without reading the content.
   */
  fingerprint?: string;
  /**
   * Task 11c: a file of this member could not be read (EACCES, EIO, ...), so
   * `content` is incomplete. Ingest keeps the member's previous graph.
   */
  unreadable?: boolean;
}

/** Task 11c: one member of an indexable source, before its content is read. */
export interface IndexedMember {
  /** Stable member key: the member's `ref.sourceUri`. */
  key: string;
  memberType: string;
  /** Sizes + mtimes of every file the member is built from. */
  fingerprint: string;
  /** Read and assemble the member (null: unreadable / malformed, skipped). */
  load(): Promise<RawMember | null>;
}

export interface MetadataSource {
  iter(): AsyncIterable<RawMember>;
  /** Task 11c: members as cheap index entries, in `iter()` order (optional). */
  iterIndexed?(): AsyncIterable<IndexedMember>;
  /**
   * Task 11c: keys of the members the last `iter()` indexed but could not
   * load (unreadable or malformed). A full ingest keeps their previous graph
   * instead of sweeping it as vanished.
   */
  unloadedKeys?(): ReadonlySet<string>;
}
