/**
 * The one comparison key for names that the graph store treats without case.
 *
 * The store declares qualified names `COLLATE NOCASE`, which in SQLite folds the 26 ASCII
 * letters A-Z only. Non-ASCII letters stay case-sensitive. `String.prototype.toLowerCase`
 * folds far more (for example `É` and the Kelvin sign), so using it would call two names the
 * same here that the store keeps apart. Use this helper wherever JavaScript code compares or
 * groups names that the store compares, and keep the original spelling for display.
 */
export function nameKey(name: string): string {
  return name.replace(/[A-Z]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 32));
}

/** True when two names are the same logical name under the store's NOCASE rule. */
export function sameName(a: string, b: string): boolean {
  return nameKey(a) === nameKey(b);
}
