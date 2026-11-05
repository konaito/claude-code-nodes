import { test, expect } from "bun:test";
import { HeaderIdentity } from "../../src/identity/identity";
import { fromLine, withFromLine, parseFromLine } from "../../src/identity/from-line";

test("HeaderIdentity reads x-cc-from and x-cc-via", () => {
  const req = new Request("http://127.0.0.1/api/x", { headers: { "x-cc-from": "ceo@fybe.jp", "x-cc-via": "pro" } });
  expect(new HeaderIdentity().callerOf(req)).toEqual({ id: "ceo@fybe.jp", via: "pro" });
});

test("HeaderIdentity defaults to local", () => {
  expect(new HeaderIdentity().callerOf(new Request("http://127.0.0.1/api/x"))).toEqual({ id: "local" });
});

test("withFromLine prefixes one line and a blank line", () => {
  expect(fromLine({ id: "agent:lead", via: "pro" }, "vm")).toBe("from agent:lead via pro");
  expect(withFromLine({ id: "ceo@fybe.jp" }, "vm", "hi")).toBe("from ceo@fybe.jp via vm\n\nhi");
});

test("parseFromLine reads the caller back", () => {
  expect(parseFromLine("from agent:lead via vm\n\nhi")).toEqual({ id: "agent:lead", via: "vm" });
  expect(parseFromLine("hi")).toBeUndefined();
  expect(parseFromLine("")).toBeUndefined();
});
