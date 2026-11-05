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
