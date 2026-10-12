import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeTestCtx } from "../../__tests__/_harness.js";
import { APEX_DFA_CLEAR_INTERVAL, ApexClassParser, resetApexDfaCounterForTest } from "../class.js";

/**
 * The apex-parser (antlr4ts) DFA cache is static per isolate and grows with
 * every distinct input. Each parse worker (and the main thread in serial mode)
 * must release it every APEX_DFA_CLEAR_INTERVAL syntax checks.
 */
const GOOD = "public class Foo { public void run() { Integer x = 1; } }";
const BAD = "public class Broken { public void run( { }";

async function atns(): Promise<{ lexer: any; parser: any }> {
  const apex = (await import("apex-parser")) as any;
  return { lexer: apex.ApexLexer._ATN, parser: apex.ApexParser._ATN };
}

describe("ApexClassParser: DFA cache release", () => {
  let lexerSpy: ReturnType<typeof vi.spyOn>;
  let parserSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    resetApexDfaCounterForTest();
    const a = await atns();
    lexerSpy = vi.spyOn(a.lexer, "clearDFA");
    parserSpy = vi.spyOn(a.parser, "clearDFA");
  });
  afterEach(() => {
    lexerSpy.mockRestore();
    parserSpy.mockRestore();
  });

  it("uses a bounded interval", () => {
    expect(APEX_DFA_CLEAR_INTERVAL).toBe(50);
  });

  it("clears lexer and parser DFA once every APEX_DFA_CLEAR_INTERVAL parses", async () => {
    const p = new ApexClassParser();
    for (let i = 0; i < APEX_DFA_CLEAR_INTERVAL - 1; i++) {
      await p.parse({ className: `C${i}`, body: GOOD }, makeTestCtx());
    }
    expect(lexerSpy).not.toHaveBeenCalled();
    expect(parserSpy).not.toHaveBeenCalled();
    await p.parse({ className: "Last", body: GOOD }, makeTestCtx());
    expect(lexerSpy).toHaveBeenCalledTimes(1);
    expect(parserSpy).toHaveBeenCalledTimes(1);
    for (let i = 0; i < APEX_DFA_CLEAR_INTERVAL; i++) {
      await p.parse({ className: `D${i}`, body: GOOD }, makeTestCtx());
    }
    expect(lexerSpy).toHaveBeenCalledTimes(2);
    expect(parserSpy).toHaveBeenCalledTimes(2);
  });

  it("the clear actually replaces the cached DFA objects (memory is releasable)", async () => {
    lexerSpy.mockRestore();
    parserSpy.mockRestore();
    const a = await atns();
    const p = new ApexClassParser();
    await p.parse({ className: "Warm", body: GOOD }, makeTestCtx());
    const lexBefore = a.lexer.decisionToDFA;
    const parBefore = a.parser.decisionToDFA;
    const lexDfa0 = lexBefore[0];
    const parDfa0 = parBefore[0];
    for (let i = 1; i < APEX_DFA_CLEAR_INTERVAL; i++) {
      await p.parse({ className: `W${i}`, body: GOOD }, makeTestCtx());
    }
    // The old DFA arrays (and the states they hold) are no longer referenced.
    // Compare identities as booleans: printing a DFA on failure exhausts the heap.
    expect({
      lexerArray: a.lexer.decisionToDFA === lexBefore,
      parserArray: a.parser.decisionToDFA === parBefore,
      lexerDfa0: a.lexer.decisionToDFA[0] === lexDfa0,
      parserDfa0: a.parser.decisionToDFA[0] === parDfa0,
    }).toEqual({ lexerArray: false, parserArray: false, lexerDfa0: false, parserDfa0: false });
  });

  it("counts failed syntax checks too", async () => {
    const p = new ApexClassParser();
    for (let i = 0; i < APEX_DFA_CLEAR_INTERVAL; i++) {
      await p.parse({ className: `B${i}`, body: BAD }, makeTestCtx());
    }
    expect(parserSpy).toHaveBeenCalledTimes(1);
    expect(lexerSpy).toHaveBeenCalledTimes(1);
  });

  it("empty bodies skip the syntax check and do not count", async () => {
    const p = new ApexClassParser();
    for (let i = 0; i < APEX_DFA_CLEAR_INTERVAL; i++) {
      await p.parse({ className: `E${i}`, body: "" }, makeTestCtx());
    }
    expect(parserSpy).not.toHaveBeenCalled();
  });

  it("parse output is identical before and after a clear", async () => {
    lexerSpy.mockRestore();
    parserSpy.mockRestore();
    const p = new ApexClassParser();
    const before = await p.parse({ className: "Foo", body: GOOD }, makeTestCtx());
    const badBefore = await p.parse({ className: "Broken", body: BAD }, makeTestCtx());
    for (let i = 0; i < APEX_DFA_CLEAR_INTERVAL; i++) {
      await p.parse({ className: `F${i}`, body: GOOD }, makeTestCtx());
    }
    const after = await p.parse({ className: "Foo", body: GOOD }, makeTestCtx());
    const badAfter = await p.parse({ className: "Broken", body: BAD }, makeTestCtx());
    expect(after).toEqual(before);
    expect(badAfter).toEqual(badBefore);
  });
});
