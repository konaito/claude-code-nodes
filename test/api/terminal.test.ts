import { test, expect } from "bun:test";
import { tmpdir } from "node:os";
import { mkdtempSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { createApp, type Deps } from "../../src/api/app";
import { SessionStore } from "../../src/sessions/store";
import { HeaderIdentity } from "../../src/identity/identity";
import { StaticRegistry } from "../../src/registry/registry";
import { Relay } from "../../src/relay/relay";
import { PtyDriver, type PtyStartOptions } from "../../src/engine/pty-driver";
import type { AgentInfo } from "../../src/engine/agents";
import { FakeDriver } from "../helpers/fake-driver";
import { fakeSpawn, type FakePty } from "../helpers/fake-pty";

const root = realpathSync(mkdtempSync(join(tmpdir(), "ccn-term-")));
const tick = () => new Promise((r) => setTimeout(r, 15));

function harness(over: Partial<Deps> = {}, agents: () => AgentInfo[] = () => []) {
  const store = new SessionStore();
  const f = fakeSpawn();
  const ptyCalls: Array<{ opts: PtyStartOptions; caller: unknown }> = [];
  const relayed: string[] = [];
  const registry = new StaticRegistry([{ name: "vm", url: "http://vm", status: "healthy", self: true }, { name: "pro", url: "https://pro.example", status: "healthy", self: false }]);
  const deps: Deps = {
    nodeName: "vm", roots: [root], lobby: root, store, identity: new HeaderIdentity(),
    history: { list: async () => [], get: async () => undefined, messages: async () => ({ messages: [] }), count: async () => 0 } as unknown as Deps["history"],
    startNode: async (opts) => { const d = new FakeDriver({ id: "node1", capabilities: { send: true, permissions: true, interrupt: true, stop: true, events: true } }); d.cwd = opts.cwd; return d; },
    startPty: async (opts, caller) => {
      ptyCalls.push({ opts, caller });
      return PtyDriver.start(opts, { spawn: f.spawn, hookBase: "http://127.0.0.1:9", caller: caller.id, tmp: root, pasteDelayMs: 0 });
    },
    agents: async () => agents(),
    terminalFor: (a) => new FakeDriver({ id: a.sessionId!, capabilities: { send: true, permissions: false, interrupt: false, stop: false, events: false }, kind: "terminal" }),
    host: async () => ({ claudeVersion: "x", load: [0] }),
    registry,
    relay: new Relay({ registry, nodeName: "vm", serviceToken: { clientId: "i", clientSecret: "s" }, fetchFn: (async (u: string) => { relayed.push(String(u)); return new Response("event: size\ndata: {}\n\n", { headers: { "content-type": "text/event-stream" } }); }) as unknown as typeof fetch }),
    appRoot: join(import.meta.dir, "..", ".."),
    ...over,
  };
  return { app: createApp(deps), store, procs: f.procs, ptyCalls, relayed };
}
const req = (path: string, init?: RequestInit) => new Request(`http://127.0.0.1${path}`, init);
const post = (path: string, body: unknown, headers: Record<string, string> = {}) => req(path, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });

async function readFrames(res: Response, n: number) {
  const reader = res.body!.getReader();
  const dec = new TextDecoder();
  let buf = "";
  const frames: Array<{ id?: number; event: string; data: any }> = [];
  while (frames.length < n) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let i: number;
    while ((i = buf.indexOf("\n\n")) >= 0 && frames.length < n) {
      const fr = buf.slice(0, i); buf = buf.slice(i + 2);
      if (fr.startsWith(":")) continue;
      const g: any = {};
      for (const line of fr.split("\n")) {
        if (line.startsWith("id: ")) g.id = Number(line.slice(4));
        else if (line.startsWith("event: ")) g.event = line.slice(7);
        else if (line.startsWith("data: ")) g.data = JSON.parse(line.slice(6));
      }
      frames.push(g);
    }
  }
  await reader.cancel().catch(() => {});
  return frames;
}
async function create(app: ReturnType<typeof createApp>, body: Record<string, unknown> = {}, headers: Record<string, string> = {}) {
  const r = await app.fetch(post("/api/sessions", { cwd: root, terminal: true, ...body }, headers));
  expect(r.status).toBe(201);
  return (await r.json()) as { id: string; kind: string; state: string };
}

test("POST /api/sessions terminal:true starts a PTY session; the caller becomes the parent and the prompt gets the from line", async () => {
  const { app, ptyCalls, procs } = harness();
  const r = await create(app, { prompt: "hello", name: "town-1", cols: 100, rows: 30, permissionMode: "default" }, { "x-ccn-from": "agent:vm/abcd1234/town" });
  expect(r.kind).toBe("pty");
  expect(r.state).toBe("running");
  expect(ptyCalls[0]!.opts).toMatchObject({ cwd: root, prompt: "from agent:vm/abcd1234/town via vm\n\nhello", name: "town-1", cols: 100, rows: 30, permissionMode: "default" });
  expect(procs[0]!.argv).toContain("--name");
  const list = await (await app.fetch(req("/api/sessions?parent=agent:vm/abcd1234/town"))).json();
  expect(list).toHaveLength(1);
  expect(list[0]).toMatchObject({ id: r.id, kind: "pty", title: "town-1", parent: "agent:vm/abcd1234/town", capabilities: { terminal: true } });
});

test("without a prompt the PTY session starts at once and waits idle", async () => {
  const { app, procs } = harness();
  const r = await create(app);
  expect(r.state).toBe("idle");
  expect(procs).toHaveLength(1);
});

test("a PTY session that claude agents also lists appears once", async () => {
  let id = "";
  const { app } = harness({}, () => [{ pid: 4242, cwd: root, kind: "interactive", startedAt: 0, sessionId: id, status: "idle" }]);
  id = (await create(app)).id;
  const list = await (await app.fetch(req("/api/sessions"))).json();
  expect(list.filter((s: { id: string }) => s.id === id)).toHaveLength(1);
  expect(list[0].kind).toBe("pty");
});

test("an agents row with the PTY's pid but another session id (after /clear in the terminal) is not listed again", async () => {
  const { app } = harness({}, () => [{ pid: 4242, cwd: root, kind: "interactive", startedAt: 0, sessionId: "cleared-id", status: "idle" }, { pid: 99, cwd: root, kind: "interactive", startedAt: 0, sessionId: "other", status: "idle" }]);
  await create(app);
  const list = await (await app.fetch(req("/api/sessions"))).json();
  expect(list.map((s: { kind: string }) => s.kind)).toEqual(["pty", "terminal"]);
  expect(list[1].id).toBe("other");
});

test("terminal:true is refused on a node without the PTY driver, and bad sizes are refused", async () => {
  const { app } = harness({ startPty: undefined });
  const r = await app.fetch(post("/api/sessions", { cwd: root, terminal: true }));
  expect(r.status).toBe(400);
  expect((await r.json()).error).toContain("terminal sessions are not supported");
  const { app: app2 } = harness();
  expect((await app2.fetch(post("/api/sessions", { cwd: root, terminal: true, cols: 5 }))).status).toBe(400);
  expect((await app2.fetch(post("/api/sessions", { cwd: root, terminal: true, name: "" }))).status).toBe(400);
});

test("omitting terminal keeps the SDK child", async () => {
  const { app, ptyCalls } = harness();
  const r = await (await app.fetch(post("/api/sessions", { cwd: root, prompt: "x" }))).json();
  expect(r.kind).toBe("node");
  expect(ptyCalls).toHaveLength(0);
});

test("GET /terminal streams size, replay of the tail, then data; ids are byte offsets and after resumes", async () => {
  const { app, procs, store } = harness();
  const { id } = await create(app);
  const p = procs[0]!;
  p.emit("hello");
  const res = await app.fetch(req(`/api/sessions/${id}/terminal`));
  expect(res.headers.get("content-type")).toContain("text/event-stream");
  const pending = readFrames(res, 3);
  await tick();
  p.emit("!");
  const fr = await pending;
  const epoch = (store.get(id) as PtyDriver).epoch;
  expect(fr[0]).toEqual({ event: "size", data: { cols: 120, rows: 40, epoch } });
  expect(fr[1]).toEqual({ id: 5, event: "replay", data: { b64: Buffer.from("hello").toString("base64") } });
  expect(fr[2]).toEqual({ id: 6, event: "data", data: { b64: Buffer.from("!").toString("base64") } });
  const again = await readFrames(await app.fetch(req(`/api/sessions/${id}/terminal?after=5&epoch=${epoch}`)), 2);
  expect(again[1]).toEqual({ id: 6, event: "data", data: { b64: Buffer.from("!").toString("base64") } });
  const byHeader = await readFrames(await app.fetch(req(`/api/sessions/${id}/terminal`, { headers: { "last-event-id": "6" } })), 1);
  expect(byHeader[0]!.event).toBe("size");
});

test("POST /terminal/input writes base64 bytes or text; /terminal/resize changes the size", async () => {
  const { app, procs } = harness();
  const { id } = await create(app);
  const p = procs[0]!;
  expect((await app.fetch(post(`/api/sessions/${id}/terminal/input`, { data: Buffer.from("\x03").toString("base64") }))).status).toBe(200);
  expect((await app.fetch(post(`/api/sessions/${id}/terminal/input`, { text: "ls\r" }))).status).toBe(200);
  expect(p.writes).toEqual(["\x03", "ls\r"]);
  expect((await app.fetch(post(`/api/sessions/${id}/terminal/input`, { data: "!!" }))).status).toBe(400);
  expect((await app.fetch(post(`/api/sessions/${id}/terminal/input`, {}))).status).toBe(400);
  const r = await app.fetch(post(`/api/sessions/${id}/terminal/resize`, { cols: 90, rows: 20 }));
  expect(await r.json()).toEqual({ ok: true, cols: 90, rows: 20 });
  expect(p.resizes).toEqual([[90, 20]]);
  expect((await app.fetch(post(`/api/sessions/${id}/terminal/resize`, { cols: 0, rows: 20 }))).status).toBe(400);
});

test("the terminal endpoints answer 409 for sessions without the terminal capability and 404 for unknown ones", async () => {
  const { app } = harness();
  const r = await (await app.fetch(post("/api/sessions", { cwd: root, prompt: "x" }))).json();
  expect((await app.fetch(req(`/api/sessions/${r.id}/terminal`))).status).toBe(409);
  expect((await app.fetch(post(`/api/sessions/${r.id}/terminal/input`, { text: "x" }))).status).toBe(409);
  expect((await app.fetch(req(`/api/sessions/nope/terminal`))).status).toBe(404);
});

test("cross-site writes to the terminal are refused like other changes", async () => {
  const { app } = harness();
  const { id } = await create(app);
  const r = await app.fetch(post(`/api/sessions/${id}/terminal/input`, { text: "x" }, { origin: "https://evil.example" }));
  expect(r.status).toBe(403);
});

test("hooks: only this machine with the session token; a PermissionRequest becomes pending and the API answer returns the decision", async () => {
  const { app, store } = harness();
  const { id } = await create(app);
  const token = (store.get(id) as PtyDriver).token;
  const body = { hook_event_name: "PermissionRequest", session_id: id, tool_name: "Bash", tool_input: { command: "rm -rf x" } };
  expect((await app.fetch(post(`/hooks/pty/${id}`, body, { "x-ccn-hook-token": "wrong" }))).status).toBe(403);
  expect((await app.fetch(post(`/hooks/pty/${id}`, body))).status).toBe(403);
  expect((await app.fetch(post(`/hooks/pty/${id}`, body, { "x-ccn-hook-token": token, "cf-connecting-ip": "1.2.3.4" }))).status).toBe(403);
  const remote = new Request(`https://vm.example/hooks/pty/${id}`, { method: "POST", headers: { "x-ccn-hook-token": token }, body: JSON.stringify(body) });
  expect((await app.fetch(remote)).status).toBe(403);
  const hook = app.fetch(post(`/hooks/pty/${id}`, body, { "x-ccn-hook-token": token }));
  await tick();
  const d = await (await app.fetch(req(`/api/sessions/${id}`))).json();
  expect(d.state).toBe("waiting_permission");
  expect(d.pending[0]).toMatchObject({ toolName: "Bash", input: { command: "rm -rf x" } });
  // 承認画面が出ている間の send は断る
  expect((await app.fetch(post(`/api/sessions/${id}/messages`, { text: "x" }))).status).toBe(409);
  const a = await app.fetch(post(`/api/sessions/${id}/permissions/${d.pending[0].requestId}`, { behavior: "deny", message: "no" }));
  expect(a.status).toBe(200);
  const hr = await hook;
  expect(await hr.json()).toEqual({ hookSpecificOutput: { hookEventName: "PermissionRequest", decision: { behavior: "deny", message: "no" } } });
  // ほかの hook は空の 200
  const stop = await app.fetch(post(`/hooks/pty/${id}`, { hook_event_name: "Stop", last_assistant_message: "ok" }, { "x-ccn-hook-token": token }));
  expect(stop.status).toBe(200);
  expect(await stop.text()).toBe("");
  const msgs = await (await app.fetch(req(`/api/sessions/${id}/messages?after=0`))).json();
  expect(msgs.messages.map((m: { type: string }) => m.type)).toEqual(["permission_request", "permission_answered", "assistant", "result"]);
});

test("send_message reaches the PTY with the from line; DELETE stops it", async () => {
  const { app, procs, store } = harness();
  const { id } = await create(app);
  await (store.get(id) as PtyDriver).hook({ hook_event_name: "SessionStart" });
  const r = await app.fetch(post(`/api/sessions/${id}/messages`, { text: "hi" }, { "x-ccn-from": "agent:vm/abcd1234/town" }));
  expect(await r.json()).toEqual({ delivered: "pty" });
  expect(procs[0]!.writes[0]).toBe("\x1b[200~from agent:vm/abcd1234/town via vm\n\nhi\x1b[201~");
  expect((await app.fetch(req(`/api/sessions/${id}`, { method: "DELETE" }))).status).toBe(204);
  expect(procs[0]!.kills).toEqual(["SIGTERM"]);
  expect(store.get(id)).toBeUndefined();
});

test("the terminal stream and input go through the relay to another node", async () => {
  const { app, relayed } = harness();
  const r = await app.fetch(req("/n/pro/api/sessions/abc/terminal?after=3"));
  expect(r.headers.get("content-type")).toContain("text/event-stream");
  await app.fetch(post("/n/pro/api/sessions/abc/terminal/input", { text: "x" }));
  expect(relayed).toEqual(["https://pro.example/api/sessions/abc/terminal?after=3", "https://pro.example/api/sessions/abc/terminal/input"]);
});

test("terminal:true without cwd starts in the lobby", async () => {
  const { app, ptyCalls } = harness();
  const r = await app.fetch(post("/api/sessions", { terminal: true }));
  expect(r.status).toBe(201);
  expect(ptyCalls[0]!.opts.cwd).toBe(root);
});
void (null as unknown as FakePty);
