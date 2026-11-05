import { test, expect } from "bun:test";
import { SessionStore } from "../../src/sessions/store";
import { FakeDriver } from "../helpers/fake-driver";

const all = { send: true, permissions: true, interrupt: true };
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
