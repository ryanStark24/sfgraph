import { APEX_PLATFORM_NAMESPACES } from "../domain/apex-platform.js";

/** The one shared list lives in domain/apex-platform.ts (the parser uses it too). */
export { APEX_PLATFORM_NAMESPACES };

/**
 * The dangling-edge audit's platform set: the ORIGINAL 76-entry core list,
 * deliberately narrower than `APEX_PLATFORM_NAMESPACES` (the parser's
 * 200-entry superset). The audit decides whether a dangling ApexClass /
 * ApexInterface / ApexMethod target is an expected platform ref or a missing
 * org class; the superset holds common words (Location, Request, Domain,
 * Page, ...) that are also typical user class names, and calling those
 * "expected platform" would hide real missing classes. The trace pseudo
 * filter keeps the superset because it also requires that no org class of
 * that name exists (`hasClass`). Lower-cased.
 */
export const AUDIT_PLATFORM_CORE: ReadonlySet<string> = new Set(
  [
    "System",
    "Assert",
    "Database",
    "Schema",
    "Test",
    "Limits",
    "UserInfo",
    "Math",
    "String",
    "Integer",
    "Long",
    "Decimal",
    "Double",
    "Boolean",
    "Date",
    "Datetime",
    "Time",
    "TimeZone",
    "Blob",
    "Id",
    "Object",
    "List",
    "Map",
    "Set",
    "JSON",
    "JSONParser",
    "JSONGenerator",
    "Type",
    "Url",
    "Pattern",
    "Matcher",
    "Crypto",
    "EncodingUtil",
    "Http",
    "HttpRequest",
    "HttpResponse",
    "Messaging",
    "ApexPages",
    "PageReference",
    "Site",
    "Network",
    "Label",
    "Approval",
    "Auth",
    "Cache",
    "ConnectApi",
    "EventBus",
    "Flow",
    "Process",
    "QuickAction",
    "Search",
    "Security",
    "Trigger",
    "Exception",
    "DmlException",
    "QueryException",
    "Dom",
    "XmlStreamReader",
    "XmlStreamWriter",
    "SObject",
    "SObjectType",
    "SObjectField",
    "DescribeSObjectResult",
    "DescribeFieldResult",
    "Queueable",
    "Schedulable",
    "Batchable",
    "Iterable",
    "Iterator",
    "Comparable",
    "Callable",
    "Savepoint",
    "Reports",
    "Metadata",
    "Canvas",
    "Invocable",
  ].map((c) => c.toLowerCase()),
);

/** First dotted segment of a qname's name part (`ApexMethod:System.debug(1)` -> `System`). */
function headOfName(name: string): string {
  return name.split(/[.(]/, 1)[0] ?? name;
}

/**
 * True for an ApexClass / ApexInterface / ApexMethod qname whose class part
 * is an Apex platform class or namespace (`ApexMethod:Database.query(1)`,
 * `ApexClass:System`). Name-only: callers that can see the node row should
 * also require that it has none.
 */
export function isApexPlatformQname(qname: string): boolean {
  const i = qname.indexOf(":");
  if (i <= 0) return false;
  const label = qname.slice(0, i);
  if (label !== "ApexClass" && label !== "ApexInterface" && label !== "ApexMethod") return false;
  return APEX_PLATFORM_NAMESPACES.has(headOfName(qname.slice(i + 1)).toLowerCase());
}
