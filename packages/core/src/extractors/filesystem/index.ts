import type { MetadataSource, RawMember } from "../interfaces/metadata-source.js";

/**
 * Filesystem-based metadata source. Phase 3 ships a stub; full implementation
 * (sfdx-project parsing, source-format walking) lands in a later phase.
 */
export class FilesystemMetadataSource implements MetadataSource {
  readonly rootDir: string;
  constructor(rootDir: string) {
    this.rootDir = rootDir;
  }

  iter(): AsyncIterable<RawMember> {
    return emptyAsyncIterable();
  }
}

async function* emptyAsyncIterable(): AsyncIterable<RawMember> {
  // intentional: phase-3 stub
  if (false as boolean) yield undefined as unknown as RawMember;
}
