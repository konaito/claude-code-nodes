import { test, expect } from "bun:test";
import { NodeDriver, type QueryFn } from "../../src/engine/node-driver";
import { makeFakeQuery } from "../helpers/fake-query";

const settle = (ms = 20) => new Promise((r) => setTimeout(r, ms));
const until = async (f: () => boolean) => { for (let i = 0; i < 50 && !f(); i++) await settle(10); expect(f()).toBe(true); };

test("start yields session id from system/init", async () => {
  const fake = makeFakeQuery();
  const d = await NodeDriver.start({ cwd: "/tmp" }, { queryFn: fake.queryFn, nodeName: "vm" });
  expect(d.id).toBe("fake-session");
  expect(d.summary().model).toBe("fake-model");
  await d.stop();
});

test("send pushes a user message the fake query receives and events flow", async () => {
  const fake = makeFakeQuery();
  const d = await NodeDriver.start({ cwd: "/tmp" }, { queryFn: fake.queryFn, nodeName: "vm" });
  const types: string[] = [];
  const reading = (async () => { for await (const e of d.events()) { types.push(e.type); if (e.type === "result") break; } })();
  await d.send("hello");
  await reading;
  expect(fake.received).toEqual(["hello"]);
  expect(types).toContain("assistant");
  expect(d.summary().state).toBe("idle");
  await d.stop();
});

test("permission request is pending until answered", async () => {
  const fake = makeFakeQuery({ permission: true });
  const d = await NodeDriver.start({ cwd: "/tmp" }, { queryFn: fake.queryFn, nodeName: "vm" });
  await d.send("write");
  await until(() => d.pending().length === 1);
  const p = d.pending()[0];
  expect(p.toolName).toBe("Write");
  expect(d.summary().state).toBe("waiting_permission");
  await d.answer(p.requestId, { behavior: "allow" });
  await until(() => fake.permissionResults.length === 1);
  expect(fake.permissionResults[0].behavior).toBe("allow");
  expect(d.pending()).toEqual([]);
  await d.stop();
});

test("interrupt calls query.interrupt", async () => {
  const fake = makeFakeQuery();
  const d = await NodeDriver.start({ cwd: "/tmp" }, { queryFn: fake.queryFn, nodeName: "vm" });
  await d.interrupt();
  expect(fake.calls.interrupt).toBe(1);
  await d.stop();
});

test("generator end marks exited with reason", async () => {
  const fake = makeFakeQuery();
  const d = await NodeDriver.start({ cwd: "/tmp" }, { queryFn: fake.queryFn, nodeName: "vm" });
  fake.die();
  await until(() => d.summary().state === "exited");
  expect(d.summary().exitReason).toBeTruthy();
});

test("send after exit rejects", async () => {
  const fake = makeFakeQuery();
  const d = await NodeDriver.start({ cwd: "/tmp" }, { queryFn: fake.queryFn, nodeName: "vm" });
  await d.stop();
  await expect(d.send("x")).rejects.toThrow();
});

test("start passes claudePath to the SDK as pathToClaudeCodeExecutable", async () => {
  const fake = makeFakeQuery();
  const d = await NodeDriver.start({ cwd: "/tmp" }, { queryFn: fake.queryFn, nodeName: "vm", claudePath: "/usr/local/bin/claude" });
  expect(fake.lastOptions?.pathToClaudeCodeExecutable).toBe("/usr/local/bin/claude");
  await d.stop();
});

// --- 最終レビューの修正（I4、I7） ---
test("bypassPermissions also sets allowDangerouslySkipPermissions for the SDK", async () => {
  const fake = makeFakeQuery();
  const d = await NodeDriver.start({ cwd: "/tmp", permissionMode: "bypassPermissions" }, { queryFn: fake.queryFn, nodeName: "vm" });
  expect(fake.lastOptions?.allowDangerouslySkipPermissions).toBe(true);
  await d.stop();
});

test("state is running right after start with a prompt", async () => {
  const fake = makeFakeQuery();
  const d = await NodeDriver.start({ cwd: "/tmp", prompt: "hi" }, { queryFn: fake.queryFn, nodeName: "vm" });
  expect(d.summary().state).toBe("running");
  await d.stop();
});

test("send while a permission is pending keeps waiting_permission", async () => {
  const fake = makeFakeQuery({ permission: true });
  const d = await NodeDriver.start({ cwd: "/tmp" }, { queryFn: fake.queryFn, nodeName: "vm" });
  await d.send("write");
  await until(() => d.pending().length === 1);
  await d.send("another");
  expect(d.summary().state).toBe("waiting_permission");
  await d.stop();
});

test("capabilities are all false after exit", async () => {
  const fake = makeFakeQuery();
  const d = await NodeDriver.start({ cwd: "/tmp" }, { queryFn: fake.queryFn, nodeName: "vm" });
  expect(d.capabilities).toEqual({ send: true, permissions: true, interrupt: true, stop: true, events: true });
  await d.stop();
  await until(() => d.summary().state === "exited");
  expect(d.capabilities).toEqual({ send: false, permissions: false, interrupt: false, stop: false, events: false });
  expect(d.summary().capabilities.stop).toBe(false);
});

test("with a sessionId and no prompt, claude is not started until the first send", async () => {
  const fake = makeFakeQuery();
  let calls = 0;
  const queryFn = ((p: never) => { calls++; return fake.queryFn(p); }) as typeof fake.queryFn;
  const sid = "22222222-2222-4222-8222-222222222222";
  const d = await NodeDriver.start({ cwd: "/tmp", sessionId: sid, permissionMode: "default", model: "m1" }, { queryFn, nodeName: "vm", caller: "agent:x" });
  expect(calls).toBe(0);
  expect(d.id).toBe(sid);
  const s = d.summary();
  expect(s.state).toBe("idle");
  expect(s.awaitingFirst).toBe(true);
  expect(s.permissionMode).toBe("default");
  expect(s.model).toBe("m1");
  expect(s.capabilities.send).toBe(true);
  // 起動前でも中断と権限モードの変更は落ちない。モードは起動のときに渡す
  await d.interrupt();
  await d.setPermissionMode("acceptEdits");
  await d.send("first");
  await d.send("second");
  expect(calls).toBe(1);
  expect(fake.lastOptions.sessionId).toBe(sid);
  expect(fake.lastOptions.permissionMode).toBe("acceptEdits");
  expect(fake.lastOptions.resume).toBeUndefined();
  await until(() => fake.received.length === 2);
  expect(fake.received).toEqual(["first", "second"]);
  expect(d.id).toBe(sid); // init の session_id（偽物は fake-session）で上書きしない
  expect(d.summary().awaitingFirst).toBeUndefined();
  await d.stop();
});

test("stopping a session that never got a message ends it without starting claude", async () => {
  const fake = makeFakeQuery();
  let calls = 0;
  const queryFn = ((p: never) => { calls++; return fake.queryFn(p); }) as typeof fake.queryFn;
  const d = await NodeDriver.start({ cwd: "/tmp", sessionId: "33333333-3333-4333-8333-333333333333" }, { queryFn, nodeName: "vm" });
  await d.stop();
  expect(calls).toBe(0);
  expect(d.summary().state).toBe("exited");
  expect(d.capabilities.send).toBe(false);
});

test("a sessionId is not passed to the SDK together with resume", async () => {
  const fake = makeFakeQuery();
  const d = await NodeDriver.start({ cwd: "/tmp", resume: "old", sessionId: "44444444-4444-4444-8444-444444444444", prompt: "go" }, { queryFn: fake.queryFn, nodeName: "vm" });
  expect(fake.lastOptions.sessionId).toBeUndefined();
  expect(fake.lastOptions.resume).toBe("old");
  await d.stop();
});

test("start passes settings to the SDK only when given (the lobby's --settings)", async () => {
  const fake = makeFakeQuery();
  const d = await NodeDriver.start({ cwd: "/tmp", settings: "/tmp/lobby/.claude/settings.json" }, { queryFn: fake.queryFn, nodeName: "vm" });
  expect(fake.lastOptions?.settings).toBe("/tmp/lobby/.claude/settings.json");
  await d.stop();
  const fake2 = makeFakeQuery();
  const d2 = await NodeDriver.start({ cwd: "/tmp" }, { queryFn: fake2.queryFn, nodeName: "vm" });
  expect(fake2.lastOptions?.settings).toBeUndefined();
  await d2.stop();
});

test("resume with defer waits for the first send, then starts claude with resume (teleport's imported sessions)", async () => {
  let started = 0;
  const fake = makeFakeQuery();
  const queryFn = ((p: Parameters<QueryFn>[0]) => { started++; return fake.queryFn(p); }) as QueryFn;
  const id = "55555555-5555-4555-8555-555555555555";
  const d = await NodeDriver.start({ cwd: "/tmp", resume: id, defer: true, permissionMode: "acceptEdits" }, { queryFn, nodeName: "vm" });
  expect(started).toBe(0);
  expect(d.id).toBe(id);
  expect(d.summary()).toMatchObject({ state: "idle", awaitingFirst: true, permissionMode: "acceptEdits" });
  await d.send("続けて");
  expect(started).toBe(1);
  expect(fake.lastOptions.resume).toBe(id);
  expect(fake.lastOptions.sessionId).toBeUndefined();
  expect(d.id).toBe(id);
  await d.stop();
});
