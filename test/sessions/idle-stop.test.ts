// #44: エージェントが立てた子を、手が空いたら台帳が止める
import { test, expect } from "bun:test";
import { SessionStore } from "../../src/sessions/store";
import { idleStoppable, isIdleStopped, IDLE_STOP_PREFIX } from "../../src/sessions/idle-stop";
import { FakeDriver } from "../helpers/fake-driver";
import type { Kind, SessionSummary } from "../../src/sessions/types";

const caps = { send: true, permissions: true, interrupt: true, stop: true, events: true };
const MS = 150; // 0.5倍や0.7倍で待つ試験の余裕を、混んだ機械でも取れる長さにする

class Child extends FakeDriver {
  parent: string | undefined = "agent:vm/abcd1234/lead";
  last = Date.now();
  view = 0;
  viewAt = 0;
  confirm = true;
  confirms = 0;
  reasons: string[] = [];
  exitReason?: string;
  constructor(id: string, kind: Kind = "pty", state: SessionSummary["state"] = "idle") { super({ id, capabilities: caps, kind }); this.state = state; }
  summary(): SessionSummary { return { ...super.summary(), parent: this.parent, lastActivityAt: this.last, exitReason: this.exitReason }; }
  viewers() { return this.view; }
  idleSince() { return this.viewAt; }
  async confirmIdle() { this.confirms++; return this.confirm; }
  async stop(reason?: string) { this.reasons.push(reason ?? ""); this.exitReason = reason; await super.stop(); }
}
const wait = (ms: number) => Bun.sleep(ms);

test("an idle child of an agent is stopped after the timeout with an idle-stop reason, and stays in the list as exited", async () => {
  const store = new SessionStore({ idleStopMs: MS });
  const d = new Child("c1");
  store.add(d);
  await wait(MS / 2);
  expect(d.reasons).toEqual([]);
  await wait(MS);
  expect(d.reasons.length).toBe(1);
  expect(d.reasons[0]!.startsWith(IDLE_STOP_PREFIX)).toBe(true);
  expect(d.reasons[0]).toContain("resume=c1");
  await wait(5);
  const s = store.list().find((x) => x.id === "c1")!;
  expect(s.state).toBe("exited");
  expect(isIdleStopped(s)).toBe(true);
});

test("sessions started by a person, terminal sessions, and sessions waiting for the first message are not stopped", async () => {
  const store = new SessionStore({ idleStopMs: MS });
  const local = new Child("l"); local.parent = "local";
  const email = new Child("e"); email.parent = "someone@example.com";
  const none = new Child("n"); none.parent = undefined;
  const term = new Child("t", "terminal");
  class Waiting extends Child { summary() { return { ...super.summary(), awaitingFirst: true }; } }
  const first = new Waiting("w", "node");
  for (const d of [local, email, none, term, first]) store.add(d);
  await wait(MS * 2.5);
  for (const d of [local, email, none, term, first]) expect(d.reasons).toEqual([]);
});

test("running and waiting for a permission are not stopped; the timer starts again when the turn ends", async () => {
  const store = new SessionStore({ idleStopMs: MS });
  const d = new Child("r", "node", "running");
  store.add(d);
  await wait(MS * 2);
  expect(d.reasons).toEqual([]);
  d.setState("waiting_permission");
  d.push({ type: "permission_request", data: {} });
  await wait(MS * 2);
  expect(d.reasons).toEqual([]);
  d.last = Date.now();
  d.setState("idle");
  d.push({ type: "result", data: {} });
  await wait(MS / 2);
  expect(d.reasons).toEqual([]);
  await wait(MS * 1.5);
  expect(d.reasons.length).toBe(1);
});

test("activity (a message, terminal input) pushes the stop back; an open terminal view keeps it alive until it closes", async () => {
  const store = new SessionStore({ idleStopMs: MS });
  const d = new Child("v");
  store.add(d);
  await wait(MS * 0.7);
  d.last = Date.now(); // 端末の入力や send は lastActivityAt を進める
  await wait(MS * 0.7);
  expect(d.reasons).toEqual([]);
  d.view = 1;
  await wait(MS * 2.5);
  expect(d.reasons).toEqual([]);
  d.view = 0;
  d.viewAt = Date.now(); // 画面を閉じたときを最後の動きとして数える
  await wait(MS * 0.7);
  expect(d.reasons).toEqual([]);
  await wait(MS * 1.5);
  expect(d.reasons.length).toBe(1);
});

test("if the process says it is still busy, it is not stopped and is checked again later", async () => {
  const store = new SessionStore({ idleStopMs: MS });
  const d = new Child("b");
  d.confirm = false;
  store.add(d);
  await wait(MS * 1.5);
  expect(d.confirms).toBe(1);
  expect(d.reasons).toEqual([]);
  d.confirm = true;
  await wait(MS * 1.5);
  expect(d.reasons.length).toBe(1);
});

test("removed sessions and an idleStopMs of 0 do not stop anything", async () => {
  const off = new SessionStore({ idleStopMs: 0 });
  const a = new Child("a");
  off.add(a);
  const on = new SessionStore({ idleStopMs: MS });
  const b = new Child("b");
  on.add(b);
  on.remove("b");
  await wait(MS * 2);
  expect(a.reasons).toEqual([]);
  expect(b.reasons).toEqual([]);
});

test("the exit reason is kept after the ended entry is swept from the store", async () => {
  let t = 10_000; // 台帳の時計は t のまま止まる。最後の動き（0）から十分たっている
  const store = new SessionStore({ idleStopMs: MS, endedTtlMs: 1000, now: () => t });
  const d = new Child("k");
  d.last = 0;
  store.add(d);
  await wait(MS * 2);
  expect(d.reasons.length).toBe(1);
  t = 20_000;
  expect(store.list().map((s) => s.id)).toEqual([]);
  expect(store.exitReasonOf("k")?.startsWith(IDLE_STOP_PREFIX)).toBe(true);
  // resume で入れ直したら忘れる
  store.add(new Child("k", "pty", "running"));
  expect(store.exitReasonOf("k")).toBeUndefined();
});

test("idleStoppable needs an agent parent, a node or pty kind, and the stop capability", () => {
  const base = { id: "x", kind: "pty" as Kind, capabilities: caps, cwd: "/", state: "idle" as const, startedAt: 0, lastActivityAt: 0, parent: "agent:a/b/c" };
  expect(idleStoppable(base)).toBe(true);
  expect(idleStoppable({ ...base, kind: "node" })).toBe(true);
  expect(idleStoppable({ ...base, kind: "terminal" })).toBe(false);
  expect(idleStoppable({ ...base, parent: "local" })).toBe(false);
  expect(idleStoppable({ ...base, capabilities: { ...caps, stop: false } })).toBe(false);
});
