import { code, nameOf, renderReport } from "./_report.js";

/**
 * Audit tools-11 hand-off: core traversals return `found: false` when the
 * seed is neither a node nor an edge endpoint. Tools turn that into an
 * explicit "node not found" answer with a find_nodes suggestion.
 */

/** A find_nodes pattern built from the last name segment of `qname`. */
export function findNodesHint(qname: string): string {
  const tail = qname.split(/[:.]/).filter(Boolean).pop() ?? qname;
  const name = tail.replace(/[*?[\]{}\\!]/g, "").slice(0, 64);
  return name ? `*${name}*` : "*";
}

/** Markdown line suggesting find_nodes for the given unknown qnames. */
export function findNodesSuggestion(qnames: readonly string[]): string {
  const hints = qnames.slice(0, 3).map((q) => `\`find_nodes { pattern: "${findNodesHint(q)}" }\``);
  return `Check the spelling with ${hints.join(", ")} (qnames look like \`ApexClass:Name\` or \`CustomField:Object.Field__c\`).`;
}

/**
 * Cycle 3 T3: the plain report for a name the graph does not hold. `what` ends the In short line
 * ("so there is nothing to trace"); `details` is the tool's lossless not-found text.
 */
export function notFoundReport(opts: {
  title: string;
  names: readonly string[];
  what: string;
  details: string;
  next?: string[];
}): string {
  const shown = opts.names.slice(0, 3).map((q) => code(nameOf(q)));
  const more = opts.names.length - shown.length;
  const list = more > 0 ? `${shown.join(", ")} and ${more} more` : shown.join(" and ");
  const verb = opts.names.length === 1 ? "is" : "are";
  return renderReport({
    title: opts.title,
    inShort: [`${list} ${verb} not in this org's graph, ${opts.what}.`],
    details: opts.details,
    next: [
      `Look up the right name with \`find_nodes\` (for example the pattern \`${findNodesHint(opts.names[0] ?? "")}\`), then ask again.`,
      ...(opts.next ?? []),
    ],
  });
}
