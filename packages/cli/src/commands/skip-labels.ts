/**
 * Source labels `--retry-skipped` should re-run from a persisted skip report:
 * every label with a skip entry, `unreadable` included. `unreadable` only
 * means "not auto-retried within the run that saw it" — an explicit
 * --retry-skipped is how the user asks to try those again.
 */
export function retrySkippedLabels(skips: Array<{ label?: string; category?: string }>): string[] {
  const out = new Set<string>();
  for (const s of skips) {
    if (s.label) out.add(s.label);
  }
  return [...out];
}
