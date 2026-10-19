import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { metadataPool, readMetadataBatchAdaptive } from "../rate-limit.js";
import {
  DEFAULT_RETRY_BACKOFF_MS,
  classifyFinalError,
  isPlatformRefusal,
  setRetryBackoffMs,
  singleItemConfirmDelaysMs,
} from "../retry.js";

/**
 * Review C1 / I1 / M1 on df3354c. `unreadable` (not auto-retried this run)
 * needs real evidence the org refuses the request deterministically:
 *  - a recognised deterministic rejection (allowlist), or
 *  - the SAME UNKNOWN_EXCEPTION on 3 attempts with growing backoff (>= ~10 s).
 * Everything else — HTTP 5xx / html bodies, codes not on the allowlist,
 * session / lock / rate-limit / network / timeout — is ALWAYS transient,
 * however often it repeats.
 */

function fault(errorCode: string, message: string): Error {
  const e = new Error(message) as Error & { errorCode: string };
  e.name = errorCode;
  e.errorCode = errorCode;
  return e;
}

const times = (n: number, make: (i: number) => Error) =>
  Array.from({ length: n }, (_, i) => make(i));

describe("classifyFinalError: transient unless proven deterministic (C1)", () => {
  const transient: Array<[string, () => Error]> = [
    [
      "ERROR_HTTP_503 with an html body",
      () => fault("ERROR_HTTP_503", "<html><body><h1>503 Service Unavailable</h1></body></html>"),
    ],
    [
      "ERROR_HTTP_502 html-content message",
      () =>
        fault(
          "ERROR_HTTP_502",
          "HTTP response contains html content.\nCheck that the org exists and can be reached.\nHTTP status code: 502",
        ),
    ],
    ["ERROR_HTTP_500", () => fault("ERROR_HTTP_500", "Internal Server Error")],
    [
      "sf:REQUEST_RUNNING_TOO_LONG",
      () => fault("sf:REQUEST_RUNNING_TOO_LONG", "Your request was running for too long"),
    ],
    ["MULTIPLE_API_ERRORS", () => fault("MULTIPLE_API_ERRORS", "multiple errors")],
    ["an unknown sf: code", () => fault("sf:SOME_NEW_FAULT", "SOME_NEW_FAULT: something odd")],
    ["sf:SERVER_UNAVAILABLE", () => fault("sf:SERVER_UNAVAILABLE", "server unavailable")],
    ["sf:UNABLE_TO_LOCK_ROW", () => fault("sf:UNABLE_TO_LOCK_ROW", "unable to obtain lock")],
    ["sf:INVALID_SESSION_ID", () => fault("sf:INVALID_SESSION_ID", "Session expired")],
    ["a timeout", () => new Error("metadata.read WorkflowRule timeout (120000ms)")],
  ];
  for (const [label, make] of transient) {
    it(`${label} repeated 4x stays retryable`, () => {
      expect(isPlatformRefusal(classifyFinalError(times(4, make)))).toBe(false);
    });
  }
});

describe("classifyFinalError: repeated UNKNOWN_EXCEPTION needs 3 identical attempts (I1)", () => {
  const gack = () => fault("sf:UNKNOWN_EXCEPTION", "UNKNOWN_EXCEPTION: unexpected metadata");

  it("two identical attempts are not enough", () => {
    expect(isPlatformRefusal(classifyFinalError(times(2, gack)))).toBe(false);
  });

  it("three identical attempts are", () => {
    expect(isPlatformRefusal(classifyFinalError(times(3, gack)))).toBe(true);
  });

  it("a gack with a fresh ErrorId but the same stack hash is identical", () => {
    const hashed = (i: number) =>
      fault(
        "sf:UNKNOWN_EXCEPTION",
        `An unexpected error occurred. Please include this ErrorId if you contact support: 1204919062-${3000 + i} (1872961130)`,
      );
    expect(isPlatformRefusal(classifyFinalError(times(3, hashed)))).toBe(true);
  });

  it("M1: hashless gacks with different ErrorIds are NOT identical", () => {
    const hashless = (i: number) =>
      fault(
        "sf:UNKNOWN_EXCEPTION",
        `An unexpected error occurred. Please include this ErrorId if you contact support: ${111 + i}-222`,
      );
    expect(isPlatformRefusal(classifyFinalError(times(3, hashless)))).toBe(false);
  });
});

describe("classifyFinalError: allowlisted deterministic rejections are unreadable at once", () => {
  const deterministic: Array<[string, Error]> = [
    [
      "INVALID_TYPE",
      fault("sf:INVALID_TYPE", "INVALID_TYPE: sObject type 'Foo' is not supported."),
    ],
    [
      "INVALID_CROSS_REFERENCE_KEY",
      fault("sf:INVALID_CROSS_REFERENCE_KEY", "invalid cross reference id"),
    ],
    [
      "an invalid ID field (Data Cloud internal query)",
      fault(
        "sf:INVALID_QUERY_FILTER_OPERATOR",
        "INVALID_QUERY_FILTER_OPERATOR: \nNamespacePrefix FROM MktDataLakeObject WHERE Id = 'X__dll'\nERROR at Row:1:Column:68\ninvalid ID field: X__dll",
      ),
    ],
    [
      "Invalid input (ManagedTopic listing)",
      fault(
        "sf:UNKNOWN_EXCEPTION",
        "UNKNOWN_EXCEPTION: Invalid input. See ManagedTopics documentation.",
      ),
    ],
    [
      "targetObject is invalid (QuickAction)",
      fault("sf:UNKNOWN_EXCEPTION", "UNKNOWN_EXCEPTION: targetObject is invalid"),
    ],
  ];
  for (const [label, err] of deterministic) {
    it(label, () => {
      expect(isPlatformRefusal(classifyFinalError([err]))).toBe(true);
    });
  }

  it("an allowlisted message on an HTTP error is still transient", () => {
    expect(
      isPlatformRefusal(
        classifyFinalError([fault("ERROR_HTTP_503", "invalid cross reference id")]),
      ),
    ).toBe(false);
  });

  it("INSUFFICIENT_ACCESS is not unreadable (a permission grant fixes it)", () => {
    expect(
      isPlatformRefusal(
        classifyFinalError([
          fault("sf:INSUFFICIENT_ACCESS", "INSUFFICIENT_ACCESS: no EventLogRead"),
        ]),
      ),
    ).toBe(false);
  });
});

describe("single-item reads confirm a gack over 3 attempts with growing backoff (I1)", () => {
  beforeEach(async () => {
    await metadataPool.incrementReservoir(10_000);
  });
  afterEach(() => setRetryBackoffMs(undefined));

  it("production schedule: growing delays totalling at least 10 s", () => {
    const delays = singleItemConfirmDelaysMs(DEFAULT_RETRY_BACKOFF_MS);
    expect(delays).toHaveLength(2);
    expect(delays[1]).toBeGreaterThan(delays[0] ?? 0);
    expect(delays.reduce((a, b) => a + b, 0)).toBeGreaterThanOrEqual(10_000);
  });

  it("reads 3 times, waiting longer before each re-try, then reports unreadable", async () => {
    setRetryBackoffMs(20);
    const at: number[] = [];
    const conn = {
      metadata: {
        read: async () => {
          at.push(Date.now());
          throw fault("sf:UNKNOWN_EXCEPTION", "UNKNOWN_EXCEPTION: unexpected metadata");
        },
      },
    };
    let failure: unknown;
    await readMetadataBatchAdaptive(
      conn,
      "AssignmentRule",
      [{ fullName: "Lead.R" }],
      0,
      (_n, e) => {
        failure = e;
      },
    );
    expect(at).toHaveLength(3);
    const [d1, d2] = [(at[1] ?? 0) - (at[0] ?? 0), (at[2] ?? 0) - (at[1] ?? 0)];
    const [w1, w2] = singleItemConfirmDelaysMs(20);
    expect(d1).toBeGreaterThanOrEqual((w1 ?? 0) - 2);
    expect(d2).toBeGreaterThanOrEqual((w2 ?? 0) - 2);
    expect(isPlatformRefusal(failure)).toBe(true);
  });

  it("a repeated HTTP 503 is read 3 times and stays retryable", async () => {
    let calls = 0;
    const conn = {
      metadata: {
        read: async () => {
          calls += 1;
          throw fault("ERROR_HTTP_503", "<html>503 Service Unavailable</html>");
        },
      },
    };
    let failure: unknown;
    await readMetadataBatchAdaptive(conn, "Layout", [{ fullName: "A-B" }], 0, (_n, e) => {
      failure = e;
    });
    expect(calls).toBe(3);
    expect(failure).toBeDefined();
    expect(isPlatformRefusal(failure)).toBe(false);
  });

  it("an allowlisted rejection is not re-read", async () => {
    let calls = 0;
    const conn = {
      metadata: {
        read: async () => {
          calls += 1;
          throw fault("sf:INVALID_CROSS_REFERENCE_KEY", "invalid cross reference id");
        },
      },
    };
    let failure: unknown;
    await readMetadataBatchAdaptive(conn, "NetworkBranding", [{ fullName: "cbX" }], 0, (_n, e) => {
      failure = e;
    });
    expect(calls).toBe(1);
    expect(isPlatformRefusal(failure)).toBe(true);
  });
});

describe("message patterns never override transient fault codes (re-review N4)", () => {
  const msg = "INVALID_QUERY_FILTER_OPERATOR-like text: invalid ID field: X__dll";
  const transient: Array<[string, () => Error]> = [
    [
      "REQUEST_LIMIT_EXCEEDED",
      () => fault("sf:REQUEST_LIMIT_EXCEEDED", `REQUEST_LIMIT_EXCEEDED: ${msg}`),
    ],
    ["UNABLE_TO_LOCK_ROW", () => fault("sf:UNABLE_TO_LOCK_ROW", `UNABLE_TO_LOCK_ROW: ${msg}`)],
    ["INVALID_SESSION_ID", () => fault("sf:INVALID_SESSION_ID", `INVALID_SESSION_ID: ${msg}`)],
    ["code-less ECONNRESET", () => new Error(`socket hang up (ECONNRESET) while ${msg}`)],
    [
      "code-less timeout",
      () => new Error("metadata.read Foo timeout (120000ms): targetObject is invalid"),
    ],
  ];
  for (const [label, make] of transient) {
    it(`${label} carrying an allowlisted message stays retryable`, () => {
      expect(isPlatformRefusal(classifyFinalError(times(4, make)))).toBe(false);
    });
  }

  it("an allowlisted message on UNKNOWN_EXCEPTION or a non-transient code is still unreadable", () => {
    expect(
      isPlatformRefusal(
        classifyFinalError([
          fault("sf:UNKNOWN_EXCEPTION", "UNKNOWN_EXCEPTION: targetObject is invalid"),
        ]),
      ),
    ).toBe(true);
    expect(
      isPlatformRefusal(
        classifyFinalError([fault("sf:INVALID_QUERY_FILTER_OPERATOR", `x\n${msg}`)]),
      ),
    ).toBe(true);
  });
});
