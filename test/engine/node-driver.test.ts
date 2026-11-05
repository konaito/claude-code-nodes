import { test, expect } from "bun:test";
import { NodeDriver } from "../../src/engine/node-driver";
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
