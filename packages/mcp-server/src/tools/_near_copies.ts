/**
 * Near-copy grouping for find_similar's report (display only).
 *
 * Each item is fingerprinted from its text: lower-cased word tokens, 3-word
 * shingles, a MinHash signature of {@link HASHES} values (double hashing over
 * two FNV-1a seeds). Items are bucketed by LSH bands, so only items sharing a
 * band are compared: the work is linear in the total text length plus the
 * bucket sizes. Two items of the same kind whose estimated Jaccard similarity
 * is at least `threshold` (default 0.8) are near-copies; groups are the
 * connected sets, and the first item of a group (in input order) represents it.
 * Items with fewer than {@link MIN_SHINGLES} shingles are never grouped: a
 * short name alone says too little to call two pieces copies.
 */

export const HASHES = 64;
const BANDS = 16;
const ROWS = HASHES / BANDS;
export const MIN_SHINGLES = 8;
export const NEAR_COPY_THRESHOLD = 0.8;

function fnv1a(s: string, seed: number): number {
  let h = seed >>> 0;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/** The 3-word shingles of `text` (lower-cased letters and digits only). */
export function shingles(text: string): Set<string> {
  const t = text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length > 1);
  const out = new Set<string>();
  for (let i = 0; i + 2 < t.length; i++) out.add(`${t[i]} ${t[i + 1]} ${t[i + 2]}`);
  return out;
}

/** MinHash signature of a shingle set ({@link HASHES} values). */
export function minhash(set: ReadonlySet<string>): Uint32Array {
  const sig = new Uint32Array(HASHES).fill(0xffffffff);
  for (const s of set) {
    const h1 = fnv1a(s, 0x811c9dc5);
    const h2 = fnv1a(s, 0x9747b28c) | 1;
    for (let i = 0; i < HASHES; i++) {
      const v = (h1 + Math.imul(i, h2)) >>> 0;
      if (v < sig[i]!) sig[i] = v;
    }
  }
  return sig;
}

/** Estimated Jaccard similarity of two signatures (share of equal values). */
export function estimate(a: Uint32Array, b: Uint32Array): number {
  let eq = 0;
  for (let i = 0; i < HASHES; i++) if (a[i] === b[i]) eq++;
  return eq / HASHES;
}

export interface NearCopyItem {
  id: string;
  kind: string;
  text: string;
}

/**
 * Map of copy id -> representative id, for every item that is a near-copy of
 * an earlier one. Items not in the map stand alone or represent a group.
 */
export function nearCopies(
  items: readonly NearCopyItem[],
  threshold = NEAR_COPY_THRESHOLD,
): Map<string, string> {
  const parent = items.map((_, i) => i);
  const find = (i: number): number => {
    while (parent[i] !== i) {
      parent[i] = parent[parent[i]!]!;
      i = parent[i]!;
    }
    return i;
  };
  const sigs: Array<Uint32Array | null> = items.map((it) => {
    const sh = shingles(it.text);
    return sh.size >= MIN_SHINGLES ? minhash(sh) : null;
  });
  const buckets = new Map<string, number[]>();
  sigs.forEach((sig, i) => {
    if (!sig) return;
    for (let b = 0; b < BANDS; b++) {
      const key = `${items[i]!.kind}|${b}|${Array.from(sig.subarray(b * ROWS, (b + 1) * ROWS)).join(",")}`;
      const list = buckets.get(key);
      if (list) list.push(i);
      else buckets.set(key, [i]);
    }
  });
  const checked = new Set<string>();
  for (const list of buckets.values()) {
    for (let x = 1; x < list.length; x++) {
      const i = list[0]!;
      const j = list[x]!;
      const pair = `${i}|${j}`;
      if (checked.has(pair)) continue;
      checked.add(pair);
      if (estimate(sigs[i]!, sigs[j]!) >= threshold) {
        const ri = find(i);
        const rj = find(j);
        // The earlier item (better rank) represents the group.
        if (ri !== rj) parent[Math.max(ri, rj)] = Math.min(ri, rj);
      }
    }
  }
  const out = new Map<string, string>();
  items.forEach((it, i) => {
    const r = find(i);
    if (r !== i) out.set(it.id, items[r]!.id);
  });
  return out;
}
