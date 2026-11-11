import { test, expect } from "bun:test";
import { formatAgent, parseAgent, sameParent } from "../../src/identity/agent-name";
import { agentName } from "../../src/cli/client";

const SID = "abcdef12-0000-0000-0000-000000000000";

test("formatAgent builds agent:<node>/<sid8>/<role> and sanitizes the role", () => {
  expect(formatAgent("pro", SID, "lead")).toBe("agent:pro/abcdef12/lead");
  expect(formatAgent("pro", SID, undefined)).toBe("agent:pro/abcdef12/parent");
  expect(formatAgent("pro", SID, "a b!c")).toBe("agent:pro/abcdef12/a-b-c");
  expect(formatAgent("pro", undefined, "lead")).toBe("agent:pro/lead");
  expect(formatAgent("pro", "not-hex", "lead")).toBe("agent:pro/lead");
  expect(formatAgent("pro", SID, "x".repeat(100)).length).toBe("agent:".length + 64);
  // client.agentName は agent: を除いた同じもの
  expect(agentName("pro", SID, "lead")).toBe("pro/abcdef12/lead");
});

test("parseAgent inverts formatAgent and rejects other caller ids", () => {
  expect(parseAgent("agent:pro/abcdef12/lead")).toEqual({ node: "pro", sid: "abcdef12", role: "lead" });
  expect(parseAgent("agent:pro/abcdef12/team/lead")).toEqual({ node: "pro", sid: "abcdef12", role: "team/lead" });
  expect(parseAgent("agent:pro/lead")).toEqual({ node: "pro", role: "lead" });
  expect(parseAgent("agent:pro/team/lead")).toEqual({ node: "pro", role: "team/lead" });
  for (const id of ["ceo@fybe.jp", "local", "agent:smoke", "agent:cc-node", "agent:/x", "agent:pro/"]) expect(parseAgent(id)).toBeUndefined();
  for (const [sid, role] of [[SID, "lead"], [undefined, "lead"], [SID, "a/b"]] as const) {
    const p = parseAgent(formatAgent("vm", sid, role))!;
    expect(p.node).toBe("vm");
    expect(p.role).toBe(role);
  }
});

test("sameParent matches the node and sid regardless of role (ccn ls --mine)", () => {
  expect(sameParent("agent:pro/abcdef12/lead", "pro", SID)).toBe(true);
  expect(sameParent("agent:pro/abcdef12/reviewer", "pro", SID)).toBe(true);
  expect(sameParent("agent:pro/ffffffff/lead", "pro", SID)).toBe(false);
  expect(sameParent("agent:vm/abcdef12/lead", "pro", SID)).toBe(false);
  expect(sameParent("ceo@fybe.jp", "pro", SID)).toBe(false);
  expect(sameParent(undefined, "pro", SID)).toBe(false);
  // sessionId が無い親は、sessionId 無しで名乗った子だけ
  expect(sameParent("agent:pro/lead", "pro", undefined)).toBe(true);
  expect(sameParent("agent:pro/abcdef12/lead", "pro", undefined)).toBe(false);
});
