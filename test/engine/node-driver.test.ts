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
