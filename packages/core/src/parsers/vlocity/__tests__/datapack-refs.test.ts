import { describe, expect, it } from "vitest";
import { REL_TYPES } from "../../../domain/index.js";
import { METADATA_CATEGORY } from "../../../domain/metadata-category.js";
import { adaptParserInput } from "../../../ingest/live-ingest.js";
import { makeTestCtx } from "../../__tests__/_harness.js";
import { OpaqueNodeParser } from "../../generic/opaque-node-parser.js";
import { collectNameMatchCandidates, scanDataPackRefs } from "../datapack-refs.js";

const dsts = (r: { dst: string }[]) => r.map((x) => x.dst).sort();

describe("scanDataPackRefs: OmniScript launch URLs", () => {
  it("plain path", () => {
    expect(
      dsts(
        scanDataPackRefs({
          Url: "/apex/ns__OmniScriptUniversalPage?id={0}#/OmniScriptType/Foo/OmniScriptSubType/Bar Baz/OmniScriptLang/English/ContextId/{0}/PrefillDataRaptorBundle//true",
        }),
      ),
    ).toEqual(["OmniScript:Foo_Bar Baz_English"]);
  });
  it("URL-encoded string and separators, nested in arrays/objects", () => {
    const enc = encodeURIComponent(
      "OmniScriptType/T1/OmniScriptSubType/S 1/OmniScriptLang/English",
    );
    const refs = scanDataPackRefs({ a: [{ b: `x?${enc}&y=1` }] });
    expect(dsts(refs)).toEqual(["OmniScript:T1_S 1_English"]);
    expect(refs[0]?.rel).toBe(REL_TYPES.REFERENCES);
  });
  it("query-string form, '+' as space, case-insensitive keys", () => {
    expect(
      dsts(
        scanDataPackRefs({
          u: "/apex/Page?omniscripttype=Typ&OmniScriptSubType=Sub+Type 2&OmniScriptLang=English&ContextId={0}",
        }),
      ),
    ).toEqual(["OmniScript:Typ_Sub Type 2_English"]);
  });
  it("two scripts in one string, deduplicated", () => {
    const s =
      "OmniScriptType/A/OmniScriptSubType/B/OmniScriptLang/English OmniScriptType/A/OmniScriptSubType/B/OmniScriptLang/English OmniScriptType/C/OmniScriptSubType/D/OmniScriptLang/French";
    expect(dsts(scanDataPackRefs({ s }))).toEqual([
      "OmniScript:A_B_English",
      "OmniScript:C_D_French",
    ]);
  });
  it("ignores malformed encodings and incomplete URLs", () => {
    expect(scanDataPackRefs({ s: "%E0%A4%A OmniScriptType/Only" })).toEqual([]);
  });
});

describe("scanDataPackRefs: DR bundle-name fields", () => {
  it("DRBundleName / BundleName suffix, non-empty strings only", () => {
    const refs = scanDataPackRefs({
      DataExtractDRBundleName: "Extract_One",
      TokenDRBundleName: " Tok Two ",
      EmbeddedTemplateTokenDRBundleName: "",
      SomeBundleName: "Three",
      PrefillDataRaptorBundle: "NotMatched",
      OtherBundleNameX: "NotMatched2",
      NumBundleName: 5,
      nested: [{ TokenDRBundleName: "Four" }],
    });
    expect(dsts(refs)).toEqual([
      "DataRaptor:Extract_One",
      "DataRaptor:Four",
      "DataRaptor:Three",
      "DataRaptor:Tok Two",
    ]);
    expect(refs.every((r) => r.rel === REL_TYPES.REFERENCES)).toBe(true);
  });
});

describe("opaque Vlocity DataPack members", () => {
  it("emit scanner edges only for Vlocity-category members", async () => {
    const raw = JSON.stringify({
      Name: "Act1",
      Url: "OmniScriptType/T/OmniScriptSubType/S/OmniScriptLang/English",
      TokenDRBundleName: "DR_Z",
    });
    const mk = (category: string) =>
      adaptParserInput(
        {
          category,
          memberType: "SomeDataPackType",
          memberName: "Act1",
          lastModifiedAt: "",
          sourceUri: "x",
          namespace: null,
        } as any,
        raw,
      )!;
    const v = mk(METADATA_CATEGORY.VLOCITY);
    const r = await new OpaqueNodeParser().parse(v.input as any, makeTestCtx());
    expect(r.nodes).toHaveLength(1);
    expect(
      r.edges.map((e) => `${e.relType} ${e.srcQualifiedName} ${e.dstQualifiedName}`).sort(),
    ).toEqual([
      "REFERENCES SomeDataPackType:Act1 DataRaptor:DR_Z",
      "REFERENCES SomeDataPackType:Act1 OmniScript:T_S_English",
    ]);
    const o = mk("OpaqueMetadata");
    expect((await new OpaqueNodeParser().parse(o.input as any, makeTestCtx())).edges).toEqual([]);
  });
});

describe("scanDataPackRefs: cards, dataSource, LWC strings", () => {
  it("Cards string array -> VlocityCard", () => {
    expect(dsts(scanDataPackRefs({ Cards: ["Card One", "Card_Two", ""] }))).toEqual([
      "VlocityCard:Card One",
      "VlocityCard:Card_Two",
    ]);
  });
  it("dataSource / Datasource objects go through classifyDataSource", () => {
    const refs = scanDataPackRefs({
      a: { dataSource: { type: "DataRaptor", value: { bundle: "DR_A" } } },
      b: [{ Datasource: { type: "IntegrationProcedures", value: { ipMethod: "IP_B" } } }],
    });
    expect(dsts(refs)).toEqual(["DataRaptor:DR_A", "IntegrationProcedure:IP_B"]);
  });
  it("c:x and c__target=c:x -> LWC:x; other namespaces skipped", () => {
    const refs = scanDataPackRefs({
      u1: "/lightning/cmp/c__target=c:myCmp",
      u2: "c:otherCmp",
      u3: "<c:inlineCmp attr='1'/>",
      u4: "vlocity_cmt:notMine",
      u5: "abc:nope",
      u6: "10:30",
    });
    expect(dsts(refs)).toEqual(["LWC:inlineCmp", "LWC:myCmp", "LWC:otherCmp"]);
  });
  it("name-match candidates are recorded for the known keys only", () => {
    const c = collectNameMatchCandidates({
      ProcessName: "IP_Thing",
      SetupValue: "DR_Other",
      MyProcName: "IP_Third",
      AutoTaskParameters: "OS_X",
      Title: "IP_Ignored",
      ProcessName2: "no",
      Empty: { ProcessName: "  " },
    });
    expect(c.sort()).toEqual(["DR_Other", "IP_Third", "IP_Thing", "OS_X"].sort());
  });
});

describe("opaque member nameMatchCandidates", () => {
  it("stored on the node when scanned keys are present", async () => {
    const v = adaptParserInput(
      {
        category: METADATA_CATEGORY.VLOCITY,
        memberType: "VlocityAction",
        memberName: "A",
        lastModifiedAt: "",
        sourceUri: "x",
        namespace: null,
      } as any,
      JSON.stringify({ ProcessName: "IP_One" }),
    )!;
    const r = await new OpaqueNodeParser().parse(v.input as any, makeTestCtx());
    expect(r.nodes[0]?.attributes.nameMatchCandidates).toEqual(["IP_One"]);
  });
});

describe("scanDataPackRefs: delimiter-anchored c: and string dataSource", () => {
  it("does not match CSS / hyphenated c:", () => {
    expect(
      scanDataPackRefs({
        css: ".btn-c:hover { } a-c:x",
        ok: "x c:good",
        eq: "k=c:eq",
        q: '"c:quoted"',
      })
        .map((r) => r.dst)
        .sort(),
    ).toEqual(["LWC:eq", "LWC:good", "LWC:quoted"]);
  });
  it("string-valued dataSource is still scanned for LWC refs / OS URLs", () => {
    const refs = scanDataPackRefs({
      dataSource: "c:viaString OmniScriptType/T/OmniScriptSubType/S/OmniScriptLang/English",
    });
    expect(dsts(refs)).toEqual(["LWC:viaString", "OmniScript:T_S_English"]);
  });
});
