import { describe, expect, it } from "vitest";
import { makeTestCtx } from "../../__tests__/_harness.js";
import { ApexClassParser } from "../class.js";

/**
 * `Page.<name>` in a controller → REFERENCES ApexPage:<name> (`via: "Page"`),
 * so a Visualforce page reached only through a redirect is not dead code.
 */
async function pageRefs(body: string, ns: string | null = null): Promise<string[]> {
  const r = await new ApexClassParser().parse(
    { className: "Ctrl", body },
    { ...makeTestCtx(), namespace: ns },
  );
  expect(r.nodes.find((n) => n.label === "ParseError")).toBeUndefined();
  return r.edges
    .filter((e) => String(e.dstQualifiedName).startsWith("ApexPage:"))
    .map((e) => `${e.relType} ${String(e.srcQualifiedName)} -> ${String(e.dstQualifiedName)}`)
    .sort();
}

describe("Apex Page.X references", () => {
  it("return Page.X, new PageReference(...) and Page.X.getUrl()", async () => {
    expect(
      await pageRefs(`public class Ctrl {
        public PageReference save() { return Page.Confirm; }
        public PageReference go() {
          PageReference page = new PageReference(Page.Detail.getUrl());
          page.getParameters().put('id', '1');
          page.setRedirect(true);
          return page;
        }
        public PageReference again() { return Page.Confirm; }
      }`),
    ).toEqual([
      "REFERENCES ApexClass:Ctrl -> ApexPage:Confirm",
      "REFERENCES ApexClass:Ctrl -> ApexPage:Detail",
    ]);
  });

  it("edges carry via: Page; own namespace stripped", async () => {
    const r = await new ApexClassParser().parse(
      {
        className: "Ctrl",
        body: "public class Ctrl { PageReference p() { return Page.acme__Home; } }",
      },
      { ...makeTestCtx(), namespace: "acme" },
    );
    const e = r.edges.find((x) => String(x.dstQualifiedName).startsWith("ApexPage:"));
    expect(String(e?.dstQualifiedName)).toBe("ApexPage:Home");
    expect(e?.attributes).toMatchObject({ via: "Page" });
  });

  it("comments, strings, ApexPages and currentPage() emit nothing", async () => {
    expect(
      await pageRefs(`public class Ctrl {
        // return Page.Old;
        String s = 'Page.InString';
        void m() {
          ApexPages.currentPage().getParameters();
          ApexPages.addMessage(null);
        }
      }`),
    ).toEqual([]);
  });

  it("a variable named page of another type is that variable", async () => {
    expect(
      await pageRefs(`public class Ctrl {
        Pager page = new Pager();
        Integer m() { return page.size; }
      }`),
    ).toEqual([]);
  });
});
