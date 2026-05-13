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
}

export interface MetadataSource {
  iter(): AsyncIterable<RawMember>;
}
