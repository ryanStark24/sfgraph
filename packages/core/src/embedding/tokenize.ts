/**
 * Split a Salesforce-style identifier into its component words so search can
 * match on word boundaries. Salesforce identifiers are overwhelmingly camelCase
 * (`getAccountById`) and snake_case / `__c` (`Customer_Tier__c`); a raw token
 * never matches a "account controller" query. We break on:
 *  - non-alphanumeric separators (`_ . : / -` and the `__c/__r/__e` markers),
 *  - camelCase boundaries (`fooBar` → `foo Bar`),
 *  - acronym→word boundaries (`HTTPResponse` → `HTTP Response`),
 *  - letter↔digit boundaries (`get2Records` → `get 2 Records`).
 */
export function splitIdentifierWords(s: string): string[] {
  const parts = s.split(/[^A-Za-z0-9]+/).filter(Boolean);
  const words: string[] = [];
  for (const p of parts) {
    const broken = p
      .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
      .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
      .replace(/([A-Za-z])([0-9])/g, "$1 $2")
      .replace(/([0-9])([A-Za-z])/g, "$1 $2");
    for (const w of broken.split(/\s+/)) if (w) words.push(w);
  }
  return words;
}

/**
 * Lowercased, de-duplicated, space-joined word form of an identifier — the text
 * appended to embeddings and indexed by FTS so `account` matches
 * `AccountController` and `customer tier` matches `Customer_Tier__c`.
 */
export function tokenizeIdentifier(s: string): string {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const w of splitIdentifierWords(s)) {
    const lw = w.toLowerCase();
    if (!seen.has(lw)) {
      seen.add(lw);
      out.push(lw);
    }
  }
  return out.join(" ");
}
