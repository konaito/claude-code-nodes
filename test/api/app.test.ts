import { test, expect, setSystemTime } from "bun:test";
import { tmpdir } from "node:os";
import { mkdtempSync, mkdirSync, symlinkSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createApp, type Deps } from "../../src/api/app";
import { SessionStore } from "../../src/sessions/store";
import { FakeDriver } from "../helpers/fake-driver";
import { HeaderIdentity, AccessDenied } from "../../src/identity/identity";
import { SocketGoneError } from "../../src/engine/terminal-driver";
import type { AgentInfo } from "../../src/engine/agents";
import { StaticRegistry } from "../../src/registry/registry";
import { Relay } from "../../src/relay/relay";

const caps = (p: boolean) => ({ send: true, permissions: p, interrupt: p, stop: p, events: p });
const term: AgentInfo = { pid: 77, cwd: "/home/u/t", kind: "interactive", startedAt: 2, sessionId: "term1", status: "busy" };
const settle = () => new Promise((r) => setTimeout(r, 10));

function harness(over: Partial<Deps> = {}) {
  const store = new SessionStore();
  const live = new FakeDriver({ id: "live1", capabilities: caps(true) });
  live.cwd = "/home/u/proj";
  store.add(live);
  const startCalls: Array<{ opts: unknown; caller: unknown }> = [];
  const registry = over.registry ?? new StaticRegistry([{ name: "vm", url: "https://vm.cc.fybe.jp", status: "healthy", self: true }, { name: "pro", url: "https://pro.cc.fybe.jp", status: "healthy", self: false }]);
  const deps: Deps = {
    nodeName: "vm",
    roots: ["/home/u", tmpdir()],
    lobby: over.lobby ?? join(tmpdir(), "ccn-test-lobby"),
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
    terminalFor: (a) => new FakeDriver({ id: a.sessionId!, capabilities: { send: true, permissions: false, interrupt: false, stop: false, events: false }, kind: "terminal" }),
    host: async () => ({ claudeVersion: "2.1.318", load: [0] }),
    registry,
    relay: new Relay({ registry, nodeName: "vm", fetchFn: (async () => new Response("{}")) as unknown as typeof fetch }),
    appRoot: join(import.meta.dir, "..", ".."),
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

test("POST /api/sessions without prompt or resume decides the id up front and starts nothing yet", async () => {
  const { app, startCalls } = harness();
  const r = await app.fetch(post("/api/sessions", { cwd: tmpdir(), sessionId: "11111111-1111-4111-8111-111111111111" }));
  expect(r.status).toBe(201);
  const opts = startCalls[0]!.opts as { prompt?: string; sessionId?: string };
  expect(opts.prompt).toBeUndefined();
  // 呼び手の sessionId は使わず、ノードが UUID を決める
  expect(opts.sessionId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  expect(opts.sessionId).not.toBe("11111111-1111-4111-8111-111111111111");
});

test("POST /api/sessions with a prompt or resume does not pass a sessionId", async () => {
  const { app, startCalls } = harness();
  await app.fetch(post("/api/sessions", { cwd: tmpdir(), prompt: "hi" }));
  await app.fetch(post("/api/sessions", { cwd: tmpdir(), resume: "old1" }));
  expect((startCalls[0]!.opts as { sessionId?: string }).sessionId).toBeUndefined();
  expect((startCalls[1]!.opts as { sessionId?: string }).sessionId).toBeUndefined();
});

test("POST /api/sessions without cwd starts in the lobby; a missing lobby is a 400 with a hint", async () => {
  const lobby = mkdtempSync(join(tmpdir(), "ccn-lobby-"));
  const { app, startCalls } = harness({ lobby });
  const r = await app.fetch(post("/api/sessions", {}));
  expect(r.status).toBe(201);
  const b = await r.json();
  expect(b.cwd).toBe(realpathSync(lobby));
  expect((startCalls[0]!.opts as { cwd: string }).cwd).toBe(realpathSync(lobby));
  const gone = harness({ lobby: join(tmpdir(), "ccn-no-such-lobby-xyz") });
  const r2 = await gone.app.fetch(post("/api/sessions", {}));
  expect(r2.status).toBe(400);
  expect((await r2.json()).error).toBe("lobby does not exist");
  expect((await harness({ lobby }).app.fetch(post("/api/sessions", { cwd: "" }))).status).toBe(400);
});

test("GET /api/host tells the lobby", async () => {
  const { app } = harness({ lobby: "/home/u/.local/share/ccn/lobby" });
  expect((await (await app.fetch(req("/api/host"))).json()).lobby).toBe("/home/u/.local/share/ccn/lobby");
});

test("POST /api/sessions creates, prefixes the from line and registers", async () => {
  const { app, store, startCalls } = harness();
  const r = await app.fetch(post("/api/sessions", { cwd: tmpdir(), prompt: "hi" }, { "x-cc-from": "agent:lead" }));
  expect(r.status).toBe(201);
  expect((await r.json()).id).toBe("new1");
  expect(store.get("new1")).toBeDefined();
  expect((startCalls[0]!.opts as { prompt: string }).prompt).toBe("from agent:lead via vm\n\nhi");
  expect(startCalls[0]!.caller).toEqual({ id: "agent:lead", kind: "local" });
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
  const gone = new FakeDriver({ id: "term1", capabilities: { send: true, permissions: false, interrupt: false, stop: false, events: false }, kind: "terminal" });
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

// 古くなった一覧の材料は待たせずに返し、裏で取り直す（2026-11-12、取り直しを待って一覧が1秒を超えた）
test("GET /api/sessions answers with the stale list while claude agents is re-read in the background", async () => {
  let calls = 0;
  let release!: (v: AgentInfo[]) => void;
  const { app } = harness({ agents: async () => { calls++; return calls === 1 ? [term] : new Promise<AgentInfo[]>((r) => { release = r; }); } });
  const t0 = Date.now();
  try {
    expect((await (await app.fetch(req("/api/sessions"))).json()).some((s: { id: string }) => s.id === "term1")).toBe(true);
    setSystemTime(new Date(t0 + 3000));
    // 取り直しは終わっていないが、古い一覧がすぐ返る
    const stale = await Promise.race([app.fetch(req("/api/sessions")).then((r) => r.json()), Bun.sleep(200).then(() => "blocked")]);
    expect(stale).not.toBe("blocked");
    expect((stale as { id: string }[]).some((s) => s.id === "term1")).toBe(true);
    expect(calls).toBe(2);
    await app.fetch(req("/api/sessions")); // 取り直しの途中なので、もう1回は起動しない
    expect(calls).toBe(2);
    release([]);
    await settle();
    expect((await (await app.fetch(req("/api/sessions"))).json()).some((s: { id: string }) => s.id === "term1")).toBe(false);
  } finally { setSystemTime(); }
});

// 終わったセッションの一覧は60秒ごとに取り直す。端末のセッションが agents から消えたら、次の要求で待たずに取り直す（#23）
test("the history list is re-read when a terminal session disappears from claude agents, not on every agents refresh", async () => {
  let hist = 0;
  let agents: AgentInfo[] = [term];
  const base = harness().deps.history;
  const { app } = harness({ agents: async () => agents, history: { ...base, list: async () => { hist++; return base.list(); } } as unknown as Deps["history"] });
  const t0 = Date.now();
  try {
    await app.fetch(req("/api/sessions"));
    expect(hist).toBe(1);
    // agents は2秒で古くなるが、変わらなければ終わったセッションの一覧は取り直さない
    setSystemTime(new Date(t0 + 3000));
    await app.fetch(req("/api/sessions"));
    await settle();
    await app.fetch(req("/api/sessions"));
    await settle();
    expect(hist).toBe(1);
    // 端末のセッションが消えた
    agents = [];
    setSystemTime(new Date(t0 + 6000));
    await app.fetch(req("/api/sessions")); // agents の取り直しが始まる
    await settle();
    await app.fetch(req("/api/sessions")); // 消えたのを見て、終わったセッションの一覧を取り直す
    await settle();
    expect(hist).toBe(2);
    // 60秒たてば、変化が無くても取り直す
    setSystemTime(new Date(t0 + 70_000));
    await app.fetch(req("/api/sessions"));
    await settle();
    expect(hist).toBe(3);
  } finally { setSystemTime(); }
});

test("DELETE makes the next list re-read the history so a just-stopped session stays listed", async () => {
  let hist = 0;
  const base = harness().deps.history;
  const { app } = harness({ history: { ...base, list: async () => { hist++; return base.list(); } } as unknown as Deps["history"] });
  await app.fetch(req("/api/sessions"));
  expect(hist).toBe(1);
  expect((await app.fetch(req("/api/sessions/live1", { method: "DELETE" }))).status).toBe(204);
  await app.fetch(req("/api/sessions"));
  await settle();
  expect(hist).toBe(2);
});

test("a failed first read of the history is not remembered; the next GET reads again", async () => {
  let calls = 0;
  const base = harness().deps.history;
  const { app } = harness({ history: { ...base, list: async () => { calls++; if (calls === 1) throw new Error("boom"); return base.list(); } } as unknown as Deps["history"] });
  expect((await app.fetch(req("/api/sessions"))).status).toBe(500);
  await settle();
  const r = await app.fetch(req("/api/sessions"));
  expect(r.status).toBe(200);
  expect((await r.json()).some((s: { id: string }) => s.id === "old1")).toBe(true);
  expect(calls).toBe(2);
});

test("GET messages of an exited live session falls back to history", async () => {
  const { app, live } = harness();
  live.push({ type: "assistant", data: { n: 1 } });
  await live.stop();
  await settle();
  const b = await (await app.fetch(req("/api/sessions/live1/messages?after=0"))).json();
  expect(b.messages[0].uuid).toBe("u1");
});

// --- 第2部 Task 0（第1部の残件） ---
test("DELETE on a session without stop capability is 409", async () => {
  const noStop = new FakeDriver({ id: "ns1", capabilities: { send: true, permissions: true, interrupt: true, stop: false, events: true } });
  const store = new SessionStore();
  store.add(noStop);
  const { app } = harness({ store });
  const r = await app.fetch(req("/api/sessions/ns1", { method: "DELETE" }));
  expect(r.status).toBe(409);
  expect(store.get("ns1")).toBeDefined();
});

test("GET events on a session without events capability is 409", async () => {
  const noEv = new FakeDriver({ id: "ne1", capabilities: { send: true, permissions: false, interrupt: false, stop: false, events: false } });
  const store = new SessionStore();
  store.add(noEv);
  const { app } = harness({ store });
  expect((await app.fetch(req("/api/sessions/ne1/events?after=0"))).status).toBe(409);
});

test("POST /api/sessions resolves a symlinked cwd before the roots check", async () => {
  const base = mkdtempSync(join(tmpdir(), "cc-link-"));
  symlinkSync("/etc", join(base, "out"));
  symlinkSync(realpathSync(base), join(base, "in"));
  const { app, startCalls } = harness();
  expect((await app.fetch(post("/api/sessions", { cwd: join(base, "out"), prompt: "x" }))).status).toBe(400);
  expect((await app.fetch(post("/api/sessions", { cwd: join(base, "in"), prompt: "x" }))).status).toBe(201);
  expect((startCalls[0]!.opts as { cwd: string }).cwd).toBe(realpathSync(base));
});

test("GET /api/host carries the last rate_limit_event", async () => {
  const { app, live } = harness();
  live.push({ type: "rate_limit_event", data: { rate_limit_info: { status: "allowed", utilization: 0.4 } } });
  await settle();
  const b = await (await app.fetch(req("/api/host"))).json();
  expect(b.rateLimit.rate_limit_info.utilization).toBe(0.4);
});

// --- Task 1: 呼び手の境界 ---
test("app returns the identity's status when it denies", async () => {
  const { app } = harness({ identity: { callerOf: async () => { throw new AccessDenied(401, "access token required"); } } });
  const r = await app.fetch(req("/api/host"));
  expect(r.status).toBe(401);
  expect((await r.json()).error).toBe("access token required");
});

// --- Task 2: CSRF（Access の cookie を持つブラウザからの別サイトの POST） ---
test("cross-site POST with a user jwt is 403", async () => {
  const user = { callerOf: async () => ({ id: "ceo@fybe.jp", kind: "user" as const }) };
  const { app } = harness({ identity: user });
  const bad = await app.fetch(post("/api/sessions/live1/messages", { text: "hi" }, { origin: "https://evil.example" }));
  expect(bad.status).toBe(403);
  const badSite = await app.fetch(post("/api/sessions/live1/messages", { text: "hi" }, { "sec-fetch-site": "cross-site" }));
  expect(badSite.status).toBe(403);
  const ok = await app.fetch(post("/api/sessions/live1/messages", { text: "hi" }, { origin: "http://127.0.0.1", "sec-fetch-site": "same-origin" }));
  expect(ok.status).toBe(200);
  const get = await app.fetch(req("/api/host", { headers: { origin: "https://evil.example" } }));
  expect(get.status).toBe(200);
});

// --- Task 3: 登録簿 ---
test("GET /api/peers returns the registry", async () => {
  const { app } = harness();
  const b = await (await app.fetch(req("/api/peers"))).json();
  expect(b).toEqual([{ name: "vm", url: "https://vm.cc.fybe.jp", status: "healthy", self: true }, { name: "pro", url: "https://pro.cc.fybe.jp", status: "healthy", self: false }]);
});

// --- Task 4: 中継 ---
test("self peer is handled locally", async () => {
  const { app } = harness();
  const a = await (await app.fetch(req("/n/vm/api/host"))).json();
  const b = await (await app.fetch(req("/api/host"))).json();
  expect(a).toEqual(b);
});

test("relay without service token is 503", async () => {
  const { app } = harness();
  const r = await app.fetch(req("/n/pro/api/host"));
  expect(r.status).toBe(503);
});

test("relay forwards to a known peer and 404s an unknown one", async () => {
  const relay = new Relay({ registry: new StaticRegistry([{ name: "pro", url: "https://pro.cc.fybe.jp", status: "healthy", self: false }]), nodeName: "vm", serviceToken: { clientId: "a", clientSecret: "b" }, fetchFn: (async (i: RequestInfo | URL) => new Response(JSON.stringify({ at: new Request(i).url }), { headers: { "content-type": "application/json" } })) as typeof fetch });
  const { app } = harness({ relay });
  expect((await (await app.fetch(req("/n/pro/api/sessions"))).json()).at).toBe("https://pro.cc.fybe.jp/api/sessions");
  expect((await app.fetch(req("/n/nope/api/sessions"))).status).toBe(404);
  expect((await app.fetch(req("/n/pro/index.html"))).status).toBe(404);
});

// --- Task 5: /install ---
test("GET /install is public and names the entry from the host header", async () => {
  const { app } = harness({ identity: { callerOf: async () => { throw new AccessDenied(401, "no"); } } });
  const r = await app.fetch(new Request("http://127.0.0.1/install", { headers: { host: "vm.cc.fybe.jp", "x-forwarded-host": "vm.cc.fybe.jp" } }));
  expect(r.status).toBe(200);
  expect(r.headers.get("content-type")).toContain("text/plain");
  expect(await r.text()).toContain("https://vm.cc.fybe.jp/install/ccn.tar.gz");
  const local = await (await app.fetch(new Request("http://127.0.0.1:4399/install", { headers: { host: "127.0.0.1:4399" } }))).text();
  expect(local).toContain("http://127.0.0.1:4399/install/ccn.tar.gz");
});

test("GET /install/cc.tar.gz is gzip", async () => {
  const { app } = harness({ identity: { callerOf: async () => { throw new AccessDenied(401, "no"); } } });
  const r = await app.fetch(req("/install/cc.tar.gz"));
  expect(r.status).toBe(200);
  expect(r.headers.get("content-type")).toBe("application/gzip");
  const bytes = new Uint8Array(await r.arrayBuffer());
  expect(bytes[0]).toBe(0x1f);
  expect(bytes[1]).toBe(0x8b);
  expect(bytes.length).toBeGreaterThan(1000);
});

// --- Task 10: 画面 ---
test("GET / serves the page to an authenticated caller", async () => {
  const { app } = harness();
  const r = await app.fetch(req("/"));
  expect(r.status).toBe(200);
  expect(r.headers.get("content-type")).toContain("text/html");
  const html = await r.text();
  expect(html).toContain("<title>Claude Code Nodes</title>");
  expect(html).toContain("/api/peers");
  expect((await app.fetch(req("/index.html"))).status).toBe(200);
  const denied = harness({ identity: { callerOf: async () => { throw new AccessDenied(401, "no"); } } });
  expect((await denied.app.fetch(req("/"))).status).toBe(401);
});

// --- 試作前の補強: トンネル越しの Origin と、自分宛ての中継の POST ---
test("same-host POST with https origin behind the tunnel is allowed", async () => {
  const user = { callerOf: async () => ({ id: "ceo@fybe.jp", kind: "user" as const }) };
  const { app, live } = harness({ identity: user });
  const r = await app.fetch(new Request("http://vm.cc.fybe.jp/api/sessions/live1/messages", { method: "POST", headers: { "content-type": "application/json", origin: "https://vm.cc.fybe.jp", "sec-fetch-site": "same-origin" }, body: JSON.stringify({ text: "hi" }) }));
  expect(r.status).toBe(200);
  expect(live.sent.at(-1)).toContain("hi");
  const other = await app.fetch(new Request("http://vm.cc.fybe.jp/api/sessions/live1/messages", { method: "POST", headers: { "content-type": "application/json", origin: "https://pro.cc.fybe.jp" }, body: JSON.stringify({ text: "hi" }) }));
  expect(other.status).toBe(403);
});

test("self peer POST is handled locally with its body", async () => {
  const { app, live } = harness();
  const r = await app.fetch(post("/n/vm/api/sessions/live1/messages", { text: "via self" }));
  expect(r.status).toBe(200);
  expect(live.sent.at(-1)).toBe("from local via vm\n\nvia self");
});

// --- 最終レビュー: ブラウザからの手元のノードへの攻撃 ---
test("cross-site POST to a local node is 403 even without a JWT", async () => {
  const { app, startCalls } = harness();
  const r = await app.fetch(new Request("http://127.0.0.1/api/sessions", { method: "POST", headers: { "content-type": "text/plain", origin: "https://evil.example", "sec-fetch-site": "cross-site" }, body: JSON.stringify({ cwd: tmpdir(), prompt: "x", permissionMode: "bypassPermissions" }) }));
  expect(r.status).toBe(403);
  expect(startCalls.length).toBe(0);
});

test("install endpoints are not cached", async () => {
  const { app } = harness();
  expect((await app.fetch(req("/install"))).headers.get("cache-control")).toBe("no-store");
  expect((await app.fetch(req("/install/cc.tar.gz"))).headers.get("cache-control")).toBe("no-store");
});

test("GET /api/sessions/:id carries the cursor: the last seq when live, the history count otherwise", async () => {
  const { app, live } = harness();
  live.push({ type: "assistant", data: 1 });
  live.push({ type: "stream_event", data: 2 });
  await settle();
  expect(((await (await app.fetch(req("/api/sessions/live1"))).json()) as { cursor: number }).cursor).toBe(2);
  const past = harness({ history: { ...harness().deps.history, count: async () => 7 } as unknown as Deps["history"] });
  expect(((await (await past.app.fetch(req("/api/sessions/old1"))).json()) as { cursor: number }).cursor).toBe(7);
  expect(((await (await past.app.fetch(req("/api/sessions/term1"))).json()) as { cursor: number }).cursor).toBe(7);
});

test("POST /api/sessions passes the lobby's settings file only to sessions in the lobby (new, explicit cwd, resume), never to other places or from the body", async () => {
  const lobby = realpathSync(mkdtempSync(join(tmpdir(), "ccn-lobby-")));
  mkdirSync(join(lobby, ".claude"));
  const file = join(lobby, ".claude", "settings.json");
  writeFileSync(file, '{"permissions":{"allow":[]}}\n');
  const child = realpathSync(mkdtempSync(join(tmpdir(), "ccn-child-")));
  const { app, startCalls } = harness({ lobby });
  const settingsOf = (i: number) => (startCalls[i]!.opts as { settings?: string }).settings;
  expect((await app.fetch(post("/api/sessions", {}))).status).toBe(201);                       // cwd を省いた受け口
  expect((await app.fetch(post("/api/sessions", { cwd: lobby, prompt: "hi" }))).status).toBe(201); // 受け口をパスで指定
  expect((await app.fetch(post("/api/sessions", { cwd: lobby, resume: "old1" }))).status).toBe(201); // 受け口の resume
  expect((await app.fetch(post("/api/sessions", { cwd: child, prompt: "work" }))).status).toBe(201); // 受け口が立てる子
  expect((await app.fetch(post("/api/sessions", { cwd: child, prompt: "x", settings: file }))).status).toBe(201); // 呼び手が渡しても使わない
  expect((await app.fetch(post("/api/sessions", { cwd: child, resume: "old1" }))).status).toBe(201); // 受け口以外の resume
  expect([0, 1, 2].map(settingsOf)).toEqual([file, file, file]);
  expect([3, 4, 5].map(settingsOf)).toEqual([undefined, undefined, undefined]);
});

// --- PWA（manifest、アイコン、Service Worker） ---
test("PWA manifest and icons are public, and the manifest is root-relative and named after the host", async () => {
  const { app } = harness({ identity: { callerOf: async () => { throw new AccessDenied(401, "no"); } } });
  const r = await app.fetch(new Request("http://127.0.0.1/pwa/manifest.webmanifest", { headers: { host: "ccn-vm.fybe.jp", "x-forwarded-host": "ccn-vm.fybe.jp" } }));
  expect(r.status).toBe(200);
  expect(r.headers.get("content-type")).toContain("application/manifest+json");
  const m = (await r.json()) as { short_name: string; start_url: string; scope: string; display: string; theme_color: string; icons: Array<{ src: string; sizes: string; purpose: string }> };
  expect(m.short_name).toBe("ccn-vm");
  expect([m.start_url, m.scope, m.display, m.theme_color]).toEqual(["/", "/", "standalone", "#ffffff"]);
  expect(m.icons.map((i) => `${i.sizes} ${i.purpose}`)).toEqual(["192x192 any", "512x512 any", "512x512 maskable"]);
  const entry = (await (await app.fetch(new Request("http://127.0.0.1/pwa/manifest.webmanifest", { headers: { host: "ccn.fybe.jp" } }))).json()) as { short_name: string };
  expect(entry.short_name).toBe("ccn");
  const local = (await (await app.fetch(req("/pwa/manifest.webmanifest"))).json()) as { short_name: string };
  expect(local.short_name).toBe("ccn");
  for (const src of [...m.icons.map((i) => i.src), "/pwa/icon-180.png"]) {
    const icon = await app.fetch(req(src));
    expect(icon.status).toBe(200);
    expect(icon.headers.get("content-type")).toBe("image/png");
    const png = new Uint8Array(await icon.arrayBuffer());
    expect([...png.slice(1, 4)].map((c) => String.fromCharCode(c)).join("")).toBe("PNG");
  }
  expect((await app.fetch(req("/pwa/nope.png"))).status).toBe(404);
  expect((await app.fetch(req("/pwa/../api/host"))).status).not.toBe(200);
});

test("the Service Worker and the page stay behind the identity check", async () => {
  const denied = harness({ identity: { callerOf: async () => { throw new AccessDenied(401, "no"); } } });
  expect((await denied.app.fetch(req("/sw.js"))).status).toBe(401);
  expect((await denied.app.fetch(req("/"))).status).toBe(401);
  const { app } = harness();
  const sw = await app.fetch(req("/sw.js"));
  expect(sw.status).toBe(200);
  expect(sw.headers.get("content-type")).toContain("javascript");
  const body = await sw.text();
  expect(body).not.toContain("caches");
  expect(body).not.toContain("respondWith");
  const page = await (await app.fetch(req("/"))).text();
  expect(page).toContain('<link rel="manifest" href="/pwa/manifest.webmanifest" crossorigin="use-credentials">');
  expect(page).toContain('<link rel="apple-touch-icon" href="/pwa/icon-180.png">');
  expect(page).toContain('navigator.serviceWorker.register("/sw.js", { scope: "/" })');
  expect(page).not.toContain("%%");
});
