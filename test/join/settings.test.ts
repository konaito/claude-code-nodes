import { test, expect } from "bun:test";
import { withCrossSessionInbound, SettingsError } from "../../src/join/settings";

test("withCrossSessionInbound merges and keeps other keys", () => {
  const out = JSON.parse(withCrossSessionInbound('{"a":1,"permissions":{"allow":["x"]}}'));
  expect(out).toEqual({ a: 1, permissions: { allow: ["x"] }, crossSessionInbound: "accept" });
  expect(JSON.parse(withCrossSessionInbound('{"crossSessionInbound":"prompt"}'))).toEqual({ crossSessionInbound: "accept" });
});

test("withCrossSessionInbound refuses empty or broken text", () => {
  expect(() => withCrossSessionInbound("")).toThrow(SettingsError);
  expect(() => withCrossSessionInbound("   \n")).toThrow(SettingsError);
  expect(() => withCrossSessionInbound("{oops")).toThrow(SettingsError);
  expect(() => withCrossSessionInbound("[]")).toThrow(SettingsError);
});
