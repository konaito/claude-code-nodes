import { test, expect } from "bun:test";
import { parseTarget, matchSession } from "../../src/cli/resolve";
import { CliError } from "../../src/cli/client";
import type { SessionSummary } from "../../src/sessions/types";

const s = (id: string): SessionSummary => ({ id, kind: "node", capabilities: { send: true, permissions: true, interrupt: true, stop: true, events: true }, cwd: "/x", state: "idle", startedAt: 0, lastActivityAt: 0 });

test("parseTarget splits peer and id", () => {
  expect(parseTarget("vm/abcd1234")).toEqual({ peer: "vm", id: "abcd1234" });
  expect(parseTarget("abcd1234-ef")).toEqual({ id: "abcd1234-ef" });
});

test("matchSession rejects short prefixes and ambiguity", () => {
  const list = [s("abcd1234-0000"), s("abcd1234-1111"), s("ffff0000-2222")];
  expect(matchSession(list, "ffff0000").id).toBe("ffff0000-2222");
  expect(matchSession(list, "abcd1234-1111").id).toBe("abcd1234-1111");
  expect(() => matchSession(list, "abcd")).toThrow(CliError);
  expect(() => matchSession(list, "abcd1234")).toThrow(/abcd1234-0000/);
  expect(() => matchSession(list, "99999999")).toThrow(CliError);
});
