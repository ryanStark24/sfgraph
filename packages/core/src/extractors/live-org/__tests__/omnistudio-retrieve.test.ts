import { Buffer } from "node:buffer";
import JSZip from "jszip";
import { describe, expect, it } from "vitest";
import type { RawMember } from "../../interfaces/metadata-source.js";
import {
  iterOmnistudioRetrieve,
  shouldSkipForQuota,
} from "../extractors/omnistudio-retrieve.js";

async function buildFixtureZip(files: Record<string, string>): Promise<string> {
  const zip = new JSZip();
  for (const [path, content] of Object.entries(files)) {
    zip.file(path, content);
  }
  const buf = await zip.generateAsync({ type: "nodebuffer" });
  return buf.toString("base64");
}

function mockConn(behaviors: {
  zipByType: Map<string, string>;
  limitInfo?: string;
  failTypes?: Set<string>;
}): unknown {
  const requested: string[] = [];
  return {
    _sforceLimitInfo: behaviors.limitInfo,
    requested,
    metadata: {
      retrieve(req: { unpackaged: { types: Array<{ name: string }> } }) {
        const type = req.unpackaged.types[0]?.name ?? "";
        requested.push(type);
        return {
          complete: async (): Promise<unknown> => {
            if (behaviors.failTypes?.has(type)) {
              throw new Error(`simulated retrieve failure for ${type}`);
            }
            const zipFile = behaviors.zipByType.get(type);
            if (!zipFile) return { status: "Succeeded", done: true, zipFile: undefined };
            return { status: "Succeeded", done: true, zipFile };
          },
        };
      },
    },
  };
}

async function collect<T>(it: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const v of it) out.push(v);
  return out;
}

describe("W2-02: shouldSkipForQuota", () => {
  it("returns false when limit info is null", () => {
    expect(shouldSkipForQuota(null)).toBe(false);
  });
  it("returns false below 90% utilization", () => {
    expect(shouldSkipForQuota({ current: 8000, limit: 10000 })).toBe(false);
  });
  it("returns true at exactly 90%", () => {
    expect(shouldSkipForQuota({ current: 9000, limit: 10000 })).toBe(true);
  });
  it("returns true above 90%", () => {
    expect(shouldSkipForQuota({ current: 9500, limit: 10000 })).toBe(true);
  });
});

describe("W2-02: iterOmnistudioRetrieve", () => {
  it("yields one RawMember per extracted file across all three types", async () => {
    const uiCardZip = await buildFixtureZip({
      "unpackaged/omniUiCards/AccountCard.omniUiCard": "<OmniUiCard><name>AccountCard</name></OmniUiCard>",
      "unpackaged/package.xml": "<Package/>",
    });
    const ipZip = await buildFixtureZip({
      "unpackaged/omniIntegrationProcedures/GetAccount.omniIntegrationProcedure":
        "<OmniIntegrationProcedure><name>GetAccount</name></OmniIntegrationProcedure>",
    });
    const dtZip = await buildFixtureZip({
      "unpackaged/omniDataTransforms/AccountToContact.omniDataTransform":
        "<OmniDataTransform><name>AccountToContact</name></OmniDataTransform>",
    });
    const conn = mockConn({
      zipByType: new Map([
        ["OmniUiCard", uiCardZip],
        ["OmniIntegrationProcedure", ipZip],
        ["OmniDataTransform", dtZip],
      ]),
    });
    const out = await collect(
      iterOmnistudioRetrieve(conn, "00Dxx0000000001", { apiVersion: "60.0" }),
    );
    expect(out.length).toBe(3);
    const types = out.map((r: RawMember) => r.ref.memberType).sort();
    expect(types).toEqual(["OmniDataTransform", "OmniIntegrationProcedure", "OmniUiCard"]);
    const names = out.map((r: RawMember) => r.ref.memberName).sort();
    expect(names).toEqual(["AccountCard", "AccountToContact", "GetAccount"]);
    // Package manifest itself is filtered out
    expect(out.some((r) => r.content.includes("<Package"))).toBe(false);
  });

  it("skips entirely when org-wide quota is above 90%", async () => {
    const errors: Array<{ label: string; message: string }> = [];
    const conn = mockConn({
      zipByType: new Map(),
      limitInfo: "api-usage=9500/10000",
    });
    const out = await collect(
      iterOmnistudioRetrieve(conn, "00Dxx0000000001", {
        apiVersion: "60.0",
        onError: (label, err) => errors.push({ label, message: err.message }),
      }),
    );
    expect(out.length).toBe(0);
    expect(errors[0]?.label).toBe("omnistudio-retrieve:quota-guard");
    expect(errors[0]?.message).toMatch(/9500\/10000/);
    // No retrieve calls attempted
    expect((conn as { requested: string[] }).requested.length).toBe(0);
  });

  it("surfaces per-type retrieve failures via onError; continues to other types", async () => {
    const errors: Array<{ label: string; message: string }> = [];
    const successZip = await buildFixtureZip({
      "unpackaged/omniDataTransforms/X.omniDataTransform": "<X/>",
    });
    const conn = mockConn({
      zipByType: new Map([["OmniDataTransform", successZip]]),
      failTypes: new Set(["OmniUiCard", "OmniIntegrationProcedure"]),
    });
    const out = await collect(
      iterOmnistudioRetrieve(conn, "00Dxx0000000001", {
        apiVersion: "60.0",
        onError: (label, err) => errors.push({ label, message: err.message }),
      }),
    );
    expect(errors.length).toBe(2);
    expect(errors.map((e) => e.label).sort()).toEqual([
      "omnistudio-retrieve:OmniIntegrationProcedure",
      "omnistudio-retrieve:OmniUiCard",
    ]);
    // OmniDataTransform still yields its one member
    expect(out.length).toBe(1);
    expect(out[0]?.ref.memberType).toBe("OmniDataTransform");
  });

  it("strips the file extension from the memberName", async () => {
    const zip = await buildFixtureZip({
      "unpackaged/omniUiCards/Card1.omniUiCard": "<X/>",
    });
    const conn = mockConn({
      zipByType: new Map([["OmniUiCard", zip]]),
    });
    const out = await collect(
      iterOmnistudioRetrieve(conn, "00Dxx0000000001", { apiVersion: "60.0" }),
    );
    expect(out[0]?.ref.memberName).toBe("Card1");
    expect(out[0]?.ref.sourceUri).toBe("sf://00Dxx0000000001/OmniUiCard/Card1.xml");
  });
});
