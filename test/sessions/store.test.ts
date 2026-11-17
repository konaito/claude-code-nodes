import { test, expect } from "bun:test";
import { SessionStore } from "../../src/sessions/store";
import { FakeDriver } from "../helpers/fake-driver";

const all = { send: true, permissions: true, interrupt: true, stop: true, events: true };
const settle = () => new Promise((r) => setTimeout(r, 10));

test("subscribe replays events after the cursor then continues", async () => {
  const d = new FakeDriver({ id: "s1", capabilities: all });
  const store = new SessionStore();
  store.add(d);
  d.push({ type: "assistant", data: 1 });
  d.push({ type: "assistant", data: 2 });
  await settle();
  const it = store.subscribe("s1", 1)[Symbol.asyncIterator]();
  expect((await it.next()).value.data).toBe(2);
  d.push({ type: "result", data: 3 });
  expect((await it.next()).value.data).toBe(3);
});

test("seq is strictly increasing per session", async () => {
  const d = new FakeDriver({ id: "s2", capabilities: all });
  const store = new SessionStore();
  store.add(d);
  d.push({ type: "a", data: null });
  d.push({ type: "b", data: null });
  d.push({ type: "c", data: null });
  await settle();
  expect(store.eventsSince("s2", 0).map((e) => e.seq)).toEqual([1, 2, 3]);
  expect(store.eventsSince("s2", 2).map((e) => e.seq)).toEqual([3]);
});

test("remove stops subscribers", async () => {
  const d = new FakeDriver({ id: "s3", capabilities: all });
  const store = new SessionStore();
  store.add(d);
  const it = store.subscribe("s3", 0)[Symbol.asyncIterator]();
  const pending = it.next();
  store.remove("s3");
  expect((await pending).done).toBe(true);
  expect(store.get("s3")).toBeUndefined();
});

test("subscribeAll emits when state changes", async () => {
  const d = new FakeDriver({ id: "s4", capabilities: all });
  const store = new SessionStore();
  store.add(d);
  const it = store.subscribeAll()[Symbol.asyncIterator]();
  const next = it.next();
  d.setState("waiting_permission");
  d.push({ type: "permission_request", data: {} });
  const v = await next;
  expect(v.value.id).toBe("s4");
  expect(v.value.summary.state).toBe("waiting_permission");
  expect(store.list().map((s) => s.id)).toEqual(["s4"]);
});

// --- 最終レビューの修正（C1、C2、I1、I2、I5、I9） ---
test("re-adding the same id closes old subscribers and carries seq on", async () => {
  const store = new SessionStore();
  const d1 = new FakeDriver({ id: "r1", capabilities: all });
  store.add(d1);
  d1.push({ type: "assistant", data: 1 }); d1.push({ type: "assistant", data: 2 });
  await settle();
  const oldSub = store.subscribe("r1", 2)[Symbol.asyncIterator]();
  const pending = oldSub.next();
  const d2 = new FakeDriver({ id: "r1", capabilities: all });
  store.add(d2);
  expect((await pending).done).toBe(true);
  d2.push({ type: "assistant", data: 3 });
  await settle();
  expect(store.eventsSince("r1", 2).map((e) => e.seq)).toEqual([3]);
});

test("subscribe after the driver ended replays and then ends", async () => {
  const store = new SessionStore();
  const d = new FakeDriver({ id: "e1", capabilities: all });
  store.add(d);
  d.push({ type: "assistant", data: 1 });
  await d.stop();
  await settle();
  const it = store.subscribe("e1", 0)[Symbol.asyncIterator]();
  expect((await it.next()).done).toBe(false);
  expect((await it.next()).done).toBe(true);
});

test("a driver whose events() throws does not crash the store and closes subscribers", async () => {
  const store = new SessionStore();
  const d = new FakeDriver({ id: "t1", capabilities: all });
  d.events = () => ({ [Symbol.asyncIterator]: () => ({ next: () => Promise.reject(new Error("driver iterator threw")) }) });
  store.add(d);
  const it = store.subscribe("t1", 0)[Symbol.asyncIterator]();
  expect((await it.next()).done).toBe(true);
  expect(store.get("t1")).toBeDefined();
});

test("stream_event is numbered but not buffered, and overflow records trimmedTo", async () => {
  const store = new SessionStore({ maxEvents: 3 });
  const d = new FakeDriver({ id: "o1", capabilities: all });
  store.add(d);
  d.push({ type: "stream_event", data: "s" });            // seq 1、ためない
  for (let i = 0; i < 5; i++) d.push({ type: "assistant", data: i }); // seq 2..6
  await settle();
  const kept = store.eventsSince("o1", 0);
  expect(kept.map((e) => e.seq)).toEqual([4, 5, 6]);
  expect(store.trimmedTo("o1")).toBe(3);
});

test("after the driver exits only the last 50 events are kept and the summary stays", async () => {
  const store = new SessionStore();
  const d = new FakeDriver({ id: "x1", capabilities: all });
  store.add(d);
  for (let i = 1; i <= 60; i++) d.push({ type: "assistant", data: i });
  await settle();
  await d.stop();
  await settle();
  const kept = store.eventsSince("x1", 0);
  expect(kept.length).toBe(50);
  expect(kept[0]!.seq).toBe(11);
  expect(store.get("x1")?.summary().state).toBe("exited");
});

test("ended sessions are swept after the ttl and beyond the cap; live ones stay", async () => {
  let t = 0;
  const store = new SessionStore({ endedTtlMs: 1000, maxEnded: 2, now: () => t });
  const live = new FakeDriver({ id: "live", capabilities: all });
  store.add(live);
  const ended = ["e1", "e2", "e3"].map((id) => new FakeDriver({ id, capabilities: all }));
  for (const d of ended) { store.add(d); await d.stop(); await settle(); t += 10; }
  // 件数の上限 2 を超えた最も古い e1 が消える
  expect(store.list().map((s) => s.id).sort()).toEqual(["e2", "e3", "live"]);
  expect(store.get("e1")).toBeUndefined();
  expect(store.lastSeq("e3")).toBeDefined();
  t += 1000;
  expect(store.list().map((s) => s.id)).toEqual(["live"]);
  expect(() => store.subscribe("e2", 0)).toThrow();
});

test("sessions that never got a first message are stopped and swept after the ttl; sent ones stay", async () => {
  let t = 0;
  const store = new SessionStore({ unsentTtlMs: 1000, now: () => t });
  class Unsent extends FakeDriver {
    awaiting = true; stopped = 0;
    summary() { return { ...super.summary(), state: "idle" as const, startedAt: 0, ...(this.awaiting ? { awaitingFirst: true } : {}) }; }
    async stop() { this.stopped++; await super.stop(); }
  }
  const caps = { send: true, permissions: true, interrupt: true, stop: true, events: true };
  const a = new Unsent({ id: "a", capabilities: caps });
  const b = new Unsent({ id: "b", capabilities: caps });
  b.awaiting = false; // 1通届いた idle
  store.add(a); store.add(b);
  t = 999;
  expect(store.list().map((s) => s.id).sort()).toEqual(["a", "b"]);
  t = 1000;
  expect(store.list().map((s) => s.id)).toEqual(["b"]);
  expect(a.stopped).toBe(1);
  expect(b.stopped).toBe(0);
});

// pty を resume で付け直すときは、番号を会話の件数（historyBase）から振る。それより前は jsonl の位置で数える
test("add with historyBase numbers events after it, and a bigger old seq wins on re-add", async () => {
  const store = new SessionStore();
  const d = new FakeDriver({ id: "p1", capabilities: all, kind: "pty" });
  store.add(d, { historyBase: 40 });
  expect(store.lastSeq("p1")).toBe(40);
  expect(store.historyBase("p1")).toBe(40);
  d.push({ type: "user", data: 1 });
  await settle();
  expect(store.eventsSince("p1", 0).map((e) => e.seq)).toEqual([41]);
  const again = new FakeDriver({ id: "p1", capabilities: all, kind: "pty" });
  store.add(again, { historyBase: 10 });
  expect(store.lastSeq("p1")).toBe(41);
  expect(store.historyBase("p1")).toBe(10);
  expect(store.historyBase("unknown")).toBe(0);
});

test("touch は、イベント無しで変わった summary を一覧の購読に流す（引き継ぎで parent を付け替えたとき）", async () => {
  const store = new SessionStore();
  const d = new FakeDriver({ id: "s1", capabilities: { send: true, permissions: true, interrupt: true, stop: true, events: true } });
  store.add(d);
  const it = store.subscribeAll()[Symbol.asyncIterator]();
  store.touch("s1");
  const c = await it.next();
  expect(c.value.id).toBe("s1");
  store.touch("unknown"); // 台帳に無い id は何もしない
});
