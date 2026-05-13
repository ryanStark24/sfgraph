import { describe, expect, it } from "vitest";
import { Sanitizer } from "../sanitizer.js";

const s = new Sanitizer();

describe("Sanitizer", () => {
  it("redacts Unix /Users path", () => {
    expect(s.sanitize("see /Users/alice/project")).toBe("see <path>");
  });
  it("redacts /home path", () => {
    expect(s.sanitize("at /home/bob/x.txt here")).toBe("at <path> here");
  });
  it("redacts /var path", () => {
    expect(s.sanitize("/var/log/foo")).toBe("<path>");
  });
  it("redacts /tmp path", () => {
    expect(s.sanitize("/tmp/x")).toBe("<path>");
  });
  it("redacts /private path", () => {
    expect(s.sanitize("/private/etc/foo")).toBe("<path>");
  });
  it("redacts Windows path", () => {
    expect(s.sanitize("C:\\Users\\bob\\file.txt")).toBe("<path>");
  });
  it("redacts email", () => {
    expect(s.sanitize("reach me at user@example.com")).toBe("reach me at <email>");
  });
  it("redacts complex email", () => {
    expect(s.sanitize("a.b+c@sub.example.co.uk")).toBe("<email>");
  });
  it("redacts salesforce.com host", () => {
    expect(s.sanitize("acme.my.salesforce.com")).toBe("<sf-host>");
  });
  it("redacts lightning.force.com", () => {
    expect(s.sanitize("foo.lightning.force.com/bar")).toBe("<sf-host>/bar");
  });
  it("redacts force.com", () => {
    expect(s.sanitize("acme.force.com")).toBe("<sf-host>");
  });
  it("redacts visualforce.com", () => {
    expect(s.sanitize("acme--c.visualforce.com")).toBe("<sf-host>");
  });
  it("redacts cloudforce.com", () => {
    expect(s.sanitize("acme.cloudforce.com")).toBe("<sf-host>");
  });
  it("redacts Authorization Bearer header", () => {
    expect(s.sanitize("Authorization: Bearer abc.def-ghi_jkl")).toBe("<bearer-token>");
  });
  it("redacts bare Bearer token", () => {
    expect(s.sanitize("Bearer eyJhbGciOiJIUzI1NiJ9")).toBe("<bearer-token>");
  });
  it("redacts SF session id", () => {
    expect(s.sanitize("00D0x000000abcd!ARMAQABCDEFghijklmnop")).toBe("<sf-session>");
  });
  it("redacts UUID", () => {
    expect(s.sanitize("550e8400-e29b-41d4-a716-446655440000")).toBe("<uuid>");
  });
  it("redacts SF record id 15 char", () => {
    expect(s.sanitize("Account 001A0000ABCDEFG")).toBe("Account <sf-id>");
  });
  it("redacts SF record id 18 char", () => {
    expect(s.sanitize("User 005A0000ABCDEFG123")).toBe("User <sf-id>");
  });
  it("passes through plain non-SF random strings", () => {
    expect(s.sanitize("zzzzzzzzzzzzzzz")).toBe("zzzzzzzzzzzzzzz");
  });
  it("recursively sanitizes object string values", () => {
    expect(s.sanitize({ path: "/Users/x/y", email: "a@b.com" })).toEqual({
      path: "<path>",
      email: "<email>",
    });
  });
  it("recursively sanitizes nested arrays", () => {
    expect(s.sanitize(["/tmp/x", ["/var/y", "a@b.com"]])).toEqual([
      "<path>",
      ["<path>", "<email>"],
    ]);
  });
  it("handles mixed nested objects", () => {
    expect(
      s.sanitize({
        inner: { token: "Bearer xyz123", host: "acme.salesforce.com" },
        list: ["/tmp/a"],
      }),
    ).toEqual({
      inner: { token: "<bearer-token>", host: "<sf-host>" },
      list: ["<path>"],
    });
  });
  it("caps recursion at max depth", () => {
    let v: any = "leaf";
    for (let i = 0; i < 20; i++) v = { nest: v };
    const out = s.sanitize(v);
    // Drill down — at some point a string '<max-depth>' must appear
    let cur: any = out;
    let found = false;
    for (let i = 0; i < 30 && cur != null; i++) {
      if (cur === "<max-depth>") {
        found = true;
        break;
      }
      cur = cur.nest;
    }
    expect(found).toBe(true);
  });
  it("passes through numbers", () => {
    expect(s.sanitize(42)).toBe(42);
  });
  it("passes through booleans", () => {
    expect(s.sanitize(false)).toBe(false);
  });
  it("passes through null", () => {
    expect(s.sanitize(null)).toBe(null);
  });
  it("passes through undefined", () => {
    expect(s.sanitize(undefined)).toBe(undefined);
  });
  it("sanitizes multiple patterns in one string", () => {
    expect(s.sanitize("user@x.com at /Users/x")).toBe("<email> at <path>");
  });
  it("sanitizeEvent strips unknown fields", () => {
    const out = s.sanitizeEvent({
      kind: "cli_command",
      ts: 1,
      command: "ingest",
      durationMs: 10,
      exitCode: 0,
      extraSecret: "/Users/x",
    });
    expect(out).not.toHaveProperty("extraSecret");
    expect(out["command"]).toBe("ingest");
  });
  it("sanitizeEvent returns {} for unknown kind", () => {
    expect(s.sanitizeEvent({ kind: "no_such_kind", x: 1 })).toEqual({});
  });
  it("sanitizeEvent sanitizes allowed string values", () => {
    const out = s.sanitizeEvent({
      kind: "ingest_failure",
      ts: 1,
      category: "ApexClass",
      errorCode: "failed at /Users/x",
    });
    expect(out["errorCode"]).toBe("failed at <path>");
  });
});
