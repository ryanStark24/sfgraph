import { describe, expect, it } from "vitest";
import { makeTestCtx } from "../../__tests__/_harness.js";
import { ApexClassParser } from "../class.js";

/**
 * A method's snippet is its own body. It used to be the block after the first
 * textual occurrence of the method's name, so a call site or a comment above
 * the declaration gave explain_code another method's lines (a Batchable's
 * `execute(1)` came back as a 5-line `if` block from elsewhere in the class).
 */
async function parse(className: string, body: string) {
  return new ApexClassParser().parse({ className, body }, makeTestCtx());
}
const snippet = (r: Awaited<ReturnType<typeof parse>>, q: string) =>
  r.snippets?.find((s) => String(s.qualifiedName) === q);

describe("ApexClassParser: method snippets", () => {
  const body = [
    "public class OrderCancel implements Queueable {", //                1
    "  // execute() re-checks the status before it cancels", //          2
    "  public static void run(Id orderId) {", //                          3
    "    if (orderId != null) {", //                                       4
    "      new OrderCancel().execute(null);", //                           5
    "    }", //                                                            6
    "  }", //                                                              7
    "  public void execute(QueueableContext ctx) {", //                   8
    "    String status = getServiceOrderStatus(1);", //                    9
    "    update new Order(Status = status);", //                          10
    "  }", //                                                             11
    "  private static String getServiceOrderStatus(Integer n) {", //     12
    "    return 'Cancel Requested';", //                                  13
    "  }", //                                                             14
    "}", //                                                               15
  ].join("\n");

  it("takes the declaration's body, not the first place the name appears", async () => {
    const r = await parse("OrderCancel", body);
    const exec = snippet(r, "ApexMethod:OrderCancel.execute(1)");
    expect(exec?.sourceText).toContain("update new Order(Status = status);");
    expect(exec?.sourceText).not.toContain("orderId");
    const status = snippet(r, "ApexMethod:OrderCancel.getServiceOrderStatus(1)");
    expect(status?.sourceText?.trim()).toBe("return 'Cancel Requested';");
  });

  it("numbers the snippet from the line its body starts on", async () => {
    const r = await parse("OrderCancel", body);
    const exec = snippet(r, "ApexMethod:OrderCancel.execute(1)");
    expect(exec?.startLine).toBe(8);
    expect(exec?.endLine).toBe(11);
    const lines = (exec?.sourceText ?? "").split("\n");
    expect(lines[10 - 8]).toContain("update new Order");
  });

  it("gives each overload its own body", async () => {
    const r = await parse(
      "Twice",
      "public class Twice {\n  public void go(Integer a) { System.debug('one'); }\n  public void go(Integer a, Integer b) { go(a); System.debug('two'); }\n}",
    );
    expect(snippet(r, "ApexMethod:Twice.go(1)")?.sourceText).toContain("'one'");
    expect(snippet(r, "ApexMethod:Twice.go(2)")?.sourceText).toContain("'two'");
  });
});
