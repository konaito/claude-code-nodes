import { test, expect } from "bun:test";
import { tmpdir } from "node:os";
import { createApp, type Deps } from "../../src/api/app";
import { SessionStore } from "../../src/sessions/store";
import { FakeDriver } from "../helpers/fake-driver";
import { HeaderIdentity } from "../../src/identity/identity";
import { SocketGoneError } from "../../src/engine/terminal-driver";
import type { AgentInfo } from "../../src/engine/agents";

const caps = (p: boolean) => ({ send: true, permissions: p, interrupt: p });
const term: AgentInfo = { pid: 77, cwd: "/home/u/t", kind: "interactive", startedAt: 2, sessionId: "term1", status: "busy" };
const settle = () => new Promise((r) => setTimeout(r, 10));

function harness(over: Partial<Deps> = {}) {
  const store = new SessionStore();
  const live = new FakeDriver({ id: "live1", capabilities: caps(true) });
  live.cwd = "/home/u/proj";
  store.add(live);
  const startCalls: Array<{ opts: unknown; caller: unknown }> = [];
  const deps: Deps = {
    nodeName: "vm",
    roots: ["/home/u", tmpdir()],
    store,
    identity: new HeaderIdentity(),
    history: {
      list: async () => [
        { id: "old1", kind: "node", capabilities: caps(false), cwd: "/home/u/x", state: "exited", startedAt: 1, lastActivityAt: 1, parent: "agent:lead" },
        { id: "live1", kind: "node", capabilities: caps(false), cwd: "/home/u/proj", state: "exited", startedAt: 1, lastActivityAt: 1 },
      ],
      messages: async (_id: string, after = 0) => ({ messages: [{ type: "user", uuid: "u1", session_id: "old1", message: {}, parent_tool_use_id: null }], next: after + 1 }),
      get: async (id: string) => (id === "old1" ? { id: "old1", kind: "node", capabilities: caps(false), cwd: "/home/u/x", state: "exited", startedAt: 1, lastActivityAt: 1, parent: "agent:lead" } : undefined),
    } as unknown as Deps["history"],
    startNode: async (opts, caller) => {
      startCalls.push({ opts, caller });
      const d = new FakeDriver({ id: "new1", capabilities: caps(true) });
      d.cwd = opts.cwd;
      return d;
    },
    agents: async () => [term],
    terminalFor: (a) => new FakeDriver({ id: a.sessionId!, capabilities: { send: true, permissions: false, interrupt: false }, kind: "terminal" }),
    host: async () => ({ claudeVersion: "2.1.318", load: [0] }),
    ...over,
  };
  return { app: createApp(deps), store, live, deps, startCalls };
}
const req = (path: string, init?: RequestInit) => new Request(`http://127.0.0.1${path}`, init);
const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
  req(path, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });

test("GET /api/host returns name and claude version", async () => {
  const { app } = harness();
  const r = await app.fetch(req("/api/host"));
  expect(r.status).toBe(200);
  const b = await r.json();
  expect(b.name).toBe("vm");
  expect(b.claudeVersion).toBe("2.1.318");
  expect(b.roots[0]).toBe("/home/u");
});

test("GET /api/sessions merges live, terminal and history without duplicates", async () => {
  const { app } = harness();
  const b = await (await app.fetch(req("/api/sessions"))).json();
  expect(b.map((s: { id: string }) => s.id)).toEqual(["live1", "term1", "old1"]);
  expect(b[1].kind).toBe("terminal");
});

test("GET /api/sessions?parent=agent:lead returns only sessions whose first prompt names that parent", async () => {
  const { app } = harness();
  const b = await (await app.fetch(req("/api/sessions?parent=agent:lead"))).json();
  expect(b.map((s: { id: string }) => s.id)).toEqual(["old1"]);
});

test("POST /api/sessions rejects cwd outside roots or missing with 400", async () => {
  const { app } = harness();
  expect((await app.fetch(post("/api/sessions", { cwd: "/etc", prompt: "x" }))).status).toBe(400);
  expect((await app.fetch(post("/api/sessions", { cwd: `${tmpdir()}/nope-cc-xyz`, prompt: "x" }))).status).toBe(400);
});

test("POST /api/sessions requires prompt or resume", async () => {
  const { app } = harness();
  expect((await app.fetch(post("/api/sessions", { cwd: tmpdir() }))).status).toBe(400);
});

test("POST /api/sessions creates, prefixes the from line and registers", async () => {
  const { app, store, startCalls } = harness();
  const r = await app.fetch(post("/api/sessions", { cwd: tmpdir(), prompt: "hi" }, { "x-cc-from": "agent:lead" }));
  expect(r.status).toBe(201);
  expect((await r.json()).id).toBe("new1");
  expect(store.get("new1")).toBeDefined();
  expect((startCalls[0]!.opts as { prompt: string }).prompt).toBe("from agent:lead via vm\n\nhi");
  expect(startCalls[0]!.caller).toEqual({ id: "agent:lead" });
});

test("POST messages prefixes the from line and returns delivered", async () => {
  const { app, live } = harness();
  const r = await app.fetch(post("/api/sessions/live1/messages", { text: "hi" }, { "x-cc-from": "ceo@fybe.jp" }));
  expect(r.status).toBe(200);
  expect((await r.json()).delivered).toBe("stdin");
  expect(live.sent[0]).toBe("from ceo@fybe.jp via vm\n\nhi");
});

test("POST permissions on a terminal session is 409", async () => {
  const { app } = harness();
  const r = await app.fetch(post("/api/sessions/term1/permissions/r1", { behavior: "allow" }));
  expect(r.status).toBe(409);
});

test("POST messages on an exited session is 409 with hint resume", async () => {
  const { app, live } = harness();
  await live.stop();
  await settle();
  const r = await app.fetch(post("/api/sessions/live1/messages", { text: "hi" }));
  expect(r.status).toBe(409);
  expect((await r.json()).hint).toBe("resume");
});

test("GET events replays after the cursor as SSE frames", async () => {
  const { app, live } = harness();
  live.push({ type: "assistant", data: { n: 1 } });
  live.push({ type: "assistant", data: { n: 2 } });
  await settle();
  const r = await app.fetch(req("/api/sessions/live1/events?after=1"));
  expect(r.headers.get("content-type")).toContain("text/event-stream");
  const reader = r.body!.getReader();
  const { value } = await reader.read();
  const text = new TextDecoder().decode(value);
  expect(text.startsWith("id: 2\nevent: assistant\ndata: ")).toBe(true);
  expect(text).toContain('"n":2');
  await reader.cancel();
});

test("pending permission shows in GET /api/sessions/:id", async () => {
  const { app, live } = harness();
  live.pendingList = [{ requestId: "r1", toolName: "Write", input: {}, createdAt: 0 }];
  const b = await (await app.fetch(req("/api/sessions/live1"))).json();
  expect(b.id).toBe("live1");
  expect(b.pending[0].requestId).toBe("r1");
});

test("POST messages when the socket is gone is 410", async () => {
  const gone = new FakeDriver({ id: "term1", capabilities: { send: true, permissions: false, interrupt: false }, kind: "terminal" });
  gone.send = async () => { throw new SocketGoneError(["/tmp/cc-socks/77.sock"]); };
  const { app } = harness({ terminalFor: () => gone });
  const r = await app.fetch(post("/api/sessions/term1/messages", { text: "hi" }));
  expect(r.status).toBe(410);
});

test("DELETE stops the session and removes it from the store", async () => {
  const { app, store } = harness();
  const r = await app.fetch(req("/api/sessions/live1", { method: "DELETE" }));
  expect(r.status).toBe(204);
  expect(store.get("live1")).toBeUndefined();
});

test("unknown session is 404", async () => {
  const { app } = harness();
  expect((await app.fetch(req("/api/sessions/nope"))).status).toBe(404);
});

// --- 最終レビューの修正（C1、I1、I3、I6、I8、I9） ---
test("POST /api/sessions with resume of a live session is 409 unless fork", async () => {
  const { app } = harness();
  const r = await app.fetch(post("/api/sessions", { cwd: tmpdir(), resume: "live1", prompt: "hi" }));
  expect(r.status).toBe(409);
  expect((await r.json()).hint).toBe("delete first");
  expect((await app.fetch(post("/api/sessions", { cwd: tmpdir(), resume: "live1", fork: true, prompt: "hi" }))).status).toBe(201);
});

test("GET events prefers Last-Event-ID over after", async () => {
  const { app, live } = harness();
  live.push({ type: "assistant", data: { n: 1 } });
  live.push({ type: "assistant", data: { n: 2 } });
  live.push({ type: "assistant", data: { n: 3 } });
  await settle();
  const r = await app.fetch(req("/api/sessions/live1/events?after=0", { headers: { "last-event-id": "2" } }));
  const { value } = await r.body!.getReader().read();
  expect(new TextDecoder().decode(value).startsWith("id: 3\n")).toBe(true);
});

test("GET events emits a gap frame when the cursor is older than the buffer", async () => {
  const store = new SessionStore({ maxEvents: 2 });
  const live = new FakeDriver({ id: "g1", capabilities: caps(true) });
  store.add(live);
  for (let i = 1; i <= 4; i++) live.push({ type: "assistant", data: i });
  await settle();
  const { app } = harness({ store });
  const r = await app.fetch(req("/api/sessions/g1/events?after=0"));
  const { value } = await r.body!.getReader().read();
  const text = new TextDecoder().decode(value);
  expect(text.startsWith("event: gap\ndata: ")).toBe(true);
  expect(text).toContain('"to":2');
});

test("GET /api/sessions/:id for a past session uses history.get, not the list", async () => {
  const { app } = harness({
    history: {
      list: async () => [],
      get: async (id: string) => (id === "deep1" ? { id: "deep1", kind: "node", capabilities: caps(false), cwd: "/home/u/d", state: "exited", startedAt: 1, lastActivityAt: 1 } : undefined),
      messages: async () => ({ messages: [] }),
    } as unknown as Deps["history"],
  });
  const r = await app.fetch(req("/api/sessions/deep1"));
  expect(r.status).toBe(200);
  expect((await r.json()).pending).toEqual([]);
});

test("GET /api/sessions twice within the cache window runs claude agents once", async () => {
  let calls = 0;
  const { app } = harness({ agents: async () => { calls++; return [term]; } });
  await app.fetch(req("/api/sessions"));
  await app.fetch(req("/api/sessions"));
  expect(calls).toBe(1);
});

test("GET messages of an exited live session falls back to history", async () => {
  const { app, live } = harness();
  live.push({ type: "assistant", data: { n: 1 } });
  await live.stop();
  await settle();
  const b = await (await app.fetch(req("/api/sessions/live1/messages?after=0"))).json();
  expect(b.messages[0].uuid).toBe("u1");
});
