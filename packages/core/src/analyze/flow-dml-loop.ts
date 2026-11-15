import { toArr, xmlParser } from "../parsers/_xml-helpers.js";

/**
 * Flow DML in a loop: a Record Create, Update or Delete element reachable inside
 * a Loop element's iteration path. The path starts at the loop's
 * `nextValueConnector` and follows every connector (including fault connectors
 * and the connectors of nested loops) until it comes back to the loop. It never
 * crosses the loop's `noMoreValuesConnector`, so a DML element after the loop is
 * not reported. Only elements whose path returns to the loop count: a path that
 * ends the flow (a fault path to a log record) runs at most once. A DML element inside a nested loop is reported once, against the
 * innermost loop that contains it.
 */

export interface FlowDmlInLoop {
  /** The Create / Update / Delete Records element. */
  element: string;
  /** `Create Records`, `Update Records` or `Delete Records`. */
  action: string;
  /** The Loop element it runs inside. */
  loop: string;
  /** The sObject, when the element names one. */
  object?: string;
  /** 1-based line of the element's opening tag in the Flow XML, or -1. */
  line: number;
}

const DML_KINDS: Record<string, string> = {
  recordCreates: "Create Records",
  recordUpdates: "Update Records",
  recordDeletes: "Delete Records",
};

/** Every element type that can carry connectors (anything with a `name`). */
type El = Record<string, unknown>;

/** The `targetReference`s of an element's connectors, `exitLoop` excluded. */
function targetsOf(el: El, includeLoopExit: boolean): string[] {
  const out: string[] = [];
  const visit = (key: string, v: unknown): void => {
    if (v === null || typeof v !== "object") return;
    if (Array.isArray(v)) {
      for (const x of v) visit(key, x);
      return;
    }
    const o = v as El;
    if (key === "noMoreValuesConnector" && !includeLoopExit) return;
    if (typeof o.targetReference === "string") out.push(o.targetReference);
    for (const [k, x] of Object.entries(o)) {
      if (k === "targetReference") continue;
      visit(k, x);
    }
  };
  for (const [k, v] of Object.entries(el)) visit(k, v);
  return out;
}

function lineOfElement(xml: string, tag: string, name: string): number {
  const open = `<${tag}>`;
  const close = `</${tag}>`;
  let from = 0;
  for (;;) {
    const i = xml.indexOf(open, from);
    if (i < 0) return -1;
    const j = xml.indexOf(close, i);
    const body = xml.slice(i, j < 0 ? xml.length : j);
    if (body.includes(`<name>${name}</name>`)) {
      let n = 1;
      for (let k = 0; k < i; k++) if (xml.charCodeAt(k) === 10) n += 1;
      return n;
    }
    from = i + open.length;
  }
}

export function detectFlowDmlInLoop(xml: string): FlowDmlInLoop[] {
  if (!xml || !xml.includes("<loops>")) return [];
  if (!/<record(?:Creates|Updates|Deletes)>/.test(xml)) return [];
  let flow: El;
  try {
    flow = ((xmlParser.parse(xml) as El).Flow ?? {}) as El;
  } catch {
    return [];
  }
  const byName = new Map<string, { type: string; el: El }>();
  for (const [type, v] of Object.entries(flow)) {
    if (type === "start" || v === null || typeof v !== "object") continue;
    for (const el of toArr(v as El | El[])) {
      if (el && typeof el === "object" && typeof (el as El).name === "string") {
        byName.set(String((el as El).name), { type, el: el as El });
      }
    }
  }
  const loops = [...byName].filter(([, e]) => e.type === "loops");
  if (loops.length === 0) return [];
  // For each loop: the elements on its iteration path.
  const iteration = new Map<string, Set<string>>();
  for (const [loopName, { el }] of loops) {
    const seen = new Set<string>();
    const first = (el as El).nextValueConnector as El | undefined;
    const stack = first && typeof first.targetReference === "string" ? [first.targetReference] : [];
    while (stack.length > 0) {
      const name = stack.pop() as string;
      if (name === loopName || seen.has(name)) continue;
      const node = byName.get(name);
      if (!node) continue;
      seen.add(name);
      // A nested loop continues both ways inside the outer iteration.
      for (const t of targetsOf(node.el, node.type === "loops")) stack.push(t);
    }
    // Only elements whose path comes back to the loop run once per record: a path
    // that ends the flow (a fault path to a log record, say) runs at most once.
    const returns = new Set<string>();
    for (let changed = true; changed; ) {
      changed = false;
      for (const name of seen) {
        if (returns.has(name)) continue;
        const node = byName.get(name);
        if (!node) continue;
        const next = targetsOf(node.el, node.type === "loops");
        if (next.some((t) => t === loopName || returns.has(t))) {
          returns.add(name);
          changed = true;
        }
      }
    }
    iteration.set(loopName, returns);
  }
  const out = new Map<string, FlowDmlInLoop>();
  const innermost = new Map<string, number>();
  for (const [loopName, seen] of iteration) {
    for (const name of seen) {
      const node = byName.get(name);
      const action = node ? DML_KINDS[node.type] : undefined;
      if (!node || !action) continue;
      const size = seen.size;
      if ((innermost.get(name) ?? Number.POSITIVE_INFINITY) <= size) continue;
      innermost.set(name, size);
      const object = typeof node.el.object === "string" ? node.el.object : undefined;
      out.set(name, {
        element: name,
        action,
        loop: loopName,
        ...(object ? { object } : {}),
        line: lineOfElement(xml, node.type, name),
      });
    }
  }
  return [...out.values()].sort((a, b) => a.line - b.line || a.element.localeCompare(b.element));
}
