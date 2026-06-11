import { describe, expect, it } from "vitest";
import { tokenizeIdentifier } from "../tokenize.js";

describe("tokenizeIdentifier", () => {
  const cases: Array<[string, string]> = [
    ["AccountController", "account controller"],
    ["getAccountById", "get account by id"],
    ["Customer_Tier__c", "customer tier c"],
    ["Account.Name", "account name"],
    ["HTTPResponse", "http response"],
    ["get2Records", "get 2 records"],
    ["My_Object__c", "my object c"],
    ["OrderItemTriggerHandler", "order item trigger handler"],
    ["simple", "simple"],
  ];
  for (const [input, expected] of cases) {
    it(`${input} -> "${expected}"`, () => {
      expect(tokenizeIdentifier(input)).toBe(expected);
    });
  }

  it("de-duplicates repeated words", () => {
    expect(tokenizeIdentifier("Account_Account")).toBe("account");
  });
});
