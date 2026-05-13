import { StorageError } from "@ryanstark24/sfgraph-shared";

const IDENT_RE = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;

export function validateLabel(label: string): string {
  if (typeof label !== "string" || !IDENT_RE.test(label)) {
    throw new StorageError(`SF_INVALID_IDENTIFIER: invalid label ${JSON.stringify(label)}`);
  }
  return label;
}

export function validateRelType(relType: string): string {
  if (typeof relType !== "string" || !IDENT_RE.test(relType)) {
    throw new StorageError(`SF_INVALID_IDENTIFIER: invalid relType ${JSON.stringify(relType)}`);
  }
  return relType;
}

export function nodeTableName(label: string): string {
  return `_sfg_n_${validateLabel(label).toLowerCase()}`;
}

export function edgeTableName(relType: string): string {
  return `_sfg_e_${validateRelType(relType).toLowerCase()}`;
}
