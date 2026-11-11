// MCP の口の試験。公式 SDK のクライアントを app.fetch につなぎ、initialize、tools/list、tools/call を偽物の Driver で通す
import { test, expect } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtempSync, realpathSync } from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createApp, type Deps } from "../../src/api/app";
import { SessionStore } from "../../src/sessions/store";
import { FakeDriver } from "../helpers/fake-driver";
import { HeaderIdentity, type Identity } from "../../src/identity/identity";
import { AccessIdentity } from "../../src/identity/access";
import { StaticRegistry } from "../../src/registry/registry";
import { Relay } from "../../src/relay/relay";
import { makeKeys } from "../helpers/jwt";

const caps = (p: boolean) => ({ send: true, permissions: p, interrupt: p, stop: p, events: p });
const settle = () => new Promise((r) => setTimeout(r, 10));
const LIVE = "11111111-2222-3333-4444-555555555555";

type Sent = { url: string; method: string; headers: Headers; body: string };
function harness(over: Partial<Deps> = {}) {
  const store = new SessionStore();
  const live = new FakeDriver({ id: LIVE, capabilities: caps(true) });
  live.cwd = "/home/u/proj";
  store.add(live);
  const starts: Array<{ opts: { prompt?: string; permissionMode?: string; cwd: string }; caller: unknown }> = [];
  const sent: Sent[] = [];
  const registry = new StaticRegistry([{ name: "vm", url: "https://ccn-vm.fybe.jp", status: "healthy", self: true }, { name: "pro", url: "https://ccn-pro.fybe.jp", status: "healthy", self: false }]);
  const relayFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const r = new Request(input, init);
    sent.push({ url: r.url, method: r.method, headers: r.headers, body: await r.text() });
    if (r.method === "POST" && new URL(r.url).pathname === "/api/sessions") return Response.json({ id: "remote-1" }, { status: 201 });
    return Response.json([{ id: "99999999-0000-0000-0000-000000000000", kind: "node", state: "idle", cwd: "/r", lastActivityAt: 5 }]);
  }) as typeof fetch;
  let clock = 0;
  const deps: Deps = {
    nodeName: "vm",
    roots: ["/home/u", tmpdir()],
    lobby: over.lobby ?? join(tmpdir(), "ccn-test-lobby"),
    store,
    identity: new HeaderIdentity(),
    history: {
      list: async () => [{ id: "old1", kind: "node", capabilities: caps(false), cwd: "/home/u/x", state: "exited", startedAt: 1, lastActivityAt: 1, parent: "agent:lead" }],
      messages: async () => ({ messages: [] }),
      get: async () => undefined,
      count: async () => 0,
    } as unknown as Deps["history"],
    startNode: async (opts, caller) => {
      starts.push({ opts: opts as (typeof starts)[number]["opts"], caller });
      const d = new FakeDriver({ id: "new1", capabilities: caps(true) });
      d.cwd = opts.cwd;
      return d;
    },
    agents: async () => [],
    terminalFor: (a) => new FakeDriver({ id: a.sessionId!, capabilities: { send: true, permissions: false, interrupt: false, stop: false, events: false }, kind: "terminal" }),
    host: async () => ({ claudeVersion: "2.1.318", load: [0] }),
    registry,
    relay: new Relay({ registry, nodeName: "vm", serviceToken: { clientId: "cid", clientSecret: "csec" }, fetchFn: relayFetch }),
    appRoot: join(import.meta.dir, "..", ".."),
    // 待ちは偽の時計で進める。sleep のたびに時計を進めるので、実時間を待たない
    mcp: { now: () => clock, sleep: async (ms) => { clock += ms; await settle(); }, pollMs: 1000 },
    ...over,
  };
  const app = createApp(deps);
  return { app, store, live, starts, sent, deps };
}

async function connect(app: { fetch: (r: Request) => Promise<Response> }, headers: Record<string, string> = {}, base = "http://127.0.0.1:4330") {
  const transport = new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
    fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
      const r = new Request(input, init);
      for (const [k, v] of Object.entries(headers)) r.headers.set(k, v);
      return app.fetch(r);
    }) as typeof fetch,
  });
  const client = new Client({ name: "test", version: "0" });
  await client.connect(transport);
  return client;
}
const text = (r: unknown) => ((r as { content: Array<{ text: string }> }).content[0]!.text);
const json = (r: unknown) => JSON.parse(text(r));

test("initialize and tools/list expose the ten tools with annotations", async () => {
  const { app } = harness();
  const c = await connect(app);
  expect(c.getServerVersion()?.name).toBe("ccn");
  expect(c.getInstructions()).toContain("/skill.md");
  const { tools } = await c.listTools();
  expect(tools.map((t) => t.name)).toEqual(["list_peers", "list_sessions", "get_session", "list_places", "create_session", "send_message", "read_messages", "answer_permission", "interrupt_session", "stop_session"]);
  const by = Object.fromEntries(tools.map((t) => [t.name, t]));
  expect(by.list_sessions!.annotations?.readOnlyHint).toBe(true);
  expect(by.read_messages!.annotations?.readOnlyHint).toBe(true);
  expect(by.stop_session!.annotations?.destructiveHint).toBe(true);
  expect(by.create_session!.annotations?.destructiveHint).toBe(false);
  expect(by.read_messages!.inputSchema.properties?.wait_seconds).toMatchObject({ maximum: 50 });
  await c.close();
});

test("list_peers and list_sessions read the same API as HTTP", async () => {
  const { app } = harness();
  const c = await connect(app);
  expect(json(await c.callTool({ name: "list_peers", arguments: {} })).map((p: { name: string }) => p.name)).toEqual(["vm", "pro"]);
  const ls = json(await c.callTool({ name: "list_sessions", arguments: {} }));
  expect(ls.sessions.map((s: { id: string }) => s.id)).toEqual([LIVE]); // exited は既定で隠す
  const all = json(await c.callTool({ name: "list_sessions", arguments: { include_exited: true } }));
  expect(all.sessions.map((s: { id: string }) => s.id).sort()).toEqual([LIVE, "old1"].sort());
  const mine = json(await c.callTool({ name: "list_sessions", arguments: { parent: "agent:lead", include_exited: true } }));
  expect(mine.sessions.map((s: { id: string }) => s.id)).toEqual(["old1"]);
});

test("send_message puts the same from line as HTTP, signs as the given role and returns the cursor before sending", async () => {
  const { app, live } = harness();
  live.push({ type: "assistant", data: { type: "assistant", message: { content: "earlier" } } });
  await settle();
  const c = await connect(app);
  const r = json(await c.callTool({ name: "send_message", arguments: { session: LIVE.slice(0, 8), text: "hello", as: "lead", as_session: "abcdef12-0000" } }));
  expect(r.cursor).toBe(1);
  expect(r.from).toBe("agent:vm/abcdef12/lead");
  expect(live.sent.at(-1)).toBe("from agent:vm/abcdef12/lead via vm\n\nhello");
  // 名乗らなければ同じ機械の呼び手（local）。HTTP の API に直接送ったときと同じ文字列
  await c.callTool({ name: "send_message", arguments: { session: LIVE, text: "plain" } });
  await app.fetch(new Request(`http://127.0.0.1/api/sessions/${LIVE}/messages`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: "plain" }) }));
  expect(live.sent.at(-2)).toBe("from local via vm\n\nplain");
  expect(live.sent.at(-1)).toBe(live.sent.at(-2));
});

test("create_session on a peer goes through the relay with the service token and the caller", async () => {
  const { app, sent } = harness();
  const c = await connect(app);
  const r = json(await c.callTool({ name: "create_session", arguments: { peer: "pro", cwd: "/r", prompt: "do it", permission_mode: "bypassPermissions", as: "lead" } }));
  expect(r).toMatchObject({ peer: "pro", id: "remote-1", parent: "agent:vm/lead", cursor: 0 });
  const post = sent.find((s) => s.method === "POST")!;
  expect(post.url).toBe("https://ccn-pro.fybe.jp/api/sessions");
  expect(JSON.parse(post.body)).toEqual({ cwd: "/r", prompt: "do it", permissionMode: "bypassPermissions" });
  expect(post.headers.get("cf-access-client-id")).toBe("cid");
  expect(post.headers.get("x-ccn-from")).toBe("agent:vm/lead");
  expect(post.headers.get("x-ccn-via")).toBe("vm");
  // 相手のセッションを先頭8文字で引くときも、一覧は中継で読む
  const g = await c.callTool({ name: "get_session", arguments: { session: "pro/99999999" } });
  expect(sent.some((s) => s.url === "https://ccn-pro.fybe.jp/api/sessions" && s.method === "GET")).toBe(true);
  expect(sent.at(-1)!.url).toBe("https://ccn-pro.fybe.jp/api/sessions/99999999-0000-0000-0000-000000000000");
  expect(g.isError).toBeFalsy();
});

test("create_session locally prefixes the prompt with the from line and leaves the permission mode to the node", async () => {
  const { app, starts } = harness();
  const c = await connect(app);
  const dir = realpathSync(tmpdir());
  const r = json(await c.callTool({ name: "create_session", arguments: { cwd: dir, prompt: "task" } }));
  expect(r).toMatchObject({ peer: "vm", id: "new1", parent: "local" });
  expect(starts[0]!.opts.prompt).toBe("from local via vm\n\ntask");
  expect(starts[0]!.opts.permissionMode).toBeUndefined();
});

test("read_messages renders the turn and stops at result with the next cursor", async () => {
  const { app, live } = harness();
  const c = await connect(app);
  const sent = json(await c.callTool({ name: "send_message", arguments: { session: LIVE, text: "go" } }));
  live.push({ type: "stream_event", data: { type: "stream_event" } });
  live.push({ type: "assistant", data: { type: "assistant", message: { content: [{ type: "text", text: "working" }, { type: "tool_use", name: "Bash", input: { command: "ls" } }] } } });
  live.push({ type: "result", data: { type: "result", subtype: "success" } });
  await settle();
  const out = text(await c.callTool({ name: "read_messages", arguments: { session: LIVE, after: sent.cursor, wait_seconds: 5 } }));
  expect(out).toContain("working");
  expect(out).toContain("[tool] Bash ls");
  expect(out).toMatch(/stop=result .* cursor=3 /);
  // 続きは無いので、締め切りまで待って timeout で返す（偽の時計）
  const again = text(await c.callTool({ name: "read_messages", arguments: { session: LIVE, after: 3, wait_seconds: 2 } }));
  expect(again).toMatch(/^stop=timeout state=running pending=0 cursor=3 /);
});

test("read_messages stops at a permission request and answer_permission answers the only pending one", async () => {
  const { app, live } = harness();
  live.pendingList = [{ requestId: "r1", toolName: "Bash", input: {}, description: "rm", createdAt: 0 }];
  live.push({ type: "permission_request", data: { requestId: "r1", toolName: "Bash", description: "rm" } });
  await settle();
  const c = await connect(app);
  const out = text(await c.callTool({ name: "read_messages", arguments: { session: LIVE } }));
  expect(out).toContain("[permission] Bash rm requestId=r1");
  expect(out).toContain("[pending] requestId=r1 Bash rm");
  expect(out).toContain("stop=permission");
  const denied = await c.callTool({ name: "answer_permission", arguments: { session: LIVE, behavior: "deny" } });
  expect(denied.isError).toBe(true);
  expect(text(denied)).toContain("deny needs a message");
  expect(json(await c.callTool({ name: "answer_permission", arguments: { session: LIVE, behavior: "allow" } }))).toMatchObject({ ok: true, requestId: "r1" });
  expect(live.answers).toEqual([{ requestId: "r1", a: { behavior: "allow" } }]);
});

test("read_messages cuts at max_chars and the cursor resumes after the last shown message", async () => {
  const { app, live } = harness();
  for (let i = 0; i < 3; i++) live.push({ type: "assistant", data: { type: "assistant", message: { content: `${i}`.repeat(600) } } });
  await settle();
  const c = await connect(app);
  const out = text(await c.callTool({ name: "read_messages", arguments: { session: LIVE, max_chars: 1000 } }));
  expect(out).toMatch(/stop=truncated .* cursor=1 /);
  const next = text(await c.callTool({ name: "read_messages", arguments: { session: LIVE, after: 1, max_chars: 1000, wait_seconds: 0 } }));
  expect(next.startsWith("1".repeat(600))).toBe(true);
});

test("reading an exited session with a live-era cursor hints to start over from 0", async () => {
  const OLD = "aaaaaaaa-0000-0000-0000-000000000000";
  const past = { id: OLD, kind: "node", capabilities: caps(false), cwd: "/home/u/x", state: "exited", startedAt: 1, lastActivityAt: 1 };
  const msgs = [{ type: "assistant", message: { content: "done" } }];
  const { app } = harness({ history: { list: async () => [past], get: async () => past, count: async () => 1, messages: async (_: string, after = 0) => ({ messages: msgs.slice(after), next: after < 1 ? 1 : undefined }) } as unknown as Deps["history"] });
  const c = await connect(app);
  const stale = text(await c.callTool({ name: "read_messages", arguments: { session: OLD, after: 34, wait_seconds: 0 } }));
  expect(stale).toContain("[hint] nothing after 34");
  expect(stale).toContain("stop=exited");
  const fresh = text(await c.callTool({ name: "read_messages", arguments: { session: OLD, after: 0, wait_seconds: 0 } }));
  expect(fresh).toMatch(/^done\nstop=exited state=exited pending=0 cursor=1 /);
});

test("capability errors come back as tool errors with the API's message", async () => {
  const term = { pid: 7, cwd: "/home/u/t", kind: "interactive", startedAt: 2, sessionId: "term1-0000-0000", status: "busy" } as const;
  const { app } = harness({ agents: async () => [term] });
  const c = await connect(app);
  const r = await c.callTool({ name: "stop_session", arguments: { session: "term1-0000-0000" } });
  expect(r.isError).toBe(true);
  expect(text(r)).toContain("409");
  expect(text(r)).toContain("capability stop not available");
  const unknown = await c.callTool({ name: "get_session", arguments: { session: "zzzzzzzz" } });
  expect(unknown.isError).toBe(true);
  expect(text(unknown)).toContain("no session matches");
});

test("an email caller keeps the email in the from line even when asking to sign as a role", async () => {
  const keys = await makeKeys();
  const identity = new AccessIdentity({ teamDomain: "t.cloudflareaccess.com", aud: "aud", fetchJwks: async () => keys.jwks });
  const { app, live } = harness({ identity });
  const jwt = await keys.sign({ aud: "aud", iss: "https://t.cloudflareaccess.com", exp: Math.floor(Date.now() / 1000) + 600, email: "owner@example.com" });
  const c = await connect(app, { "cf-access-jwt-assertion": jwt, "cf-connecting-ip": "1.2.3.4", "x-ccn-from": "agent:forged" }, "https://ccn.example.com");
  const r = json(await c.callTool({ name: "send_message", arguments: { session: LIVE, text: "hi", as: "lead" } }));
  expect(r.from).toBe("owner@example.com");
  expect(r.note).toContain("as is ignored");
  expect(live.sent.at(-1)).toBe("from owner@example.com via vm\n\nhi");
});

test("a service-token caller may sign as a role, like the x-ccn-from header over HTTP", async () => {
  const keys = await makeKeys();
  const identity = new AccessIdentity({ teamDomain: "t.cloudflareaccess.com", aud: "aud", fetchJwks: async () => keys.jwks });
  const { app, live } = harness({ identity });
  const jwt = await keys.sign({ aud: "aud", iss: "https://t.cloudflareaccess.com", exp: Math.floor(Date.now() / 1000) + 600, common_name: "cid.access" });
  const c = await connect(app, { "cf-access-jwt-assertion": jwt, "cf-connecting-ip": "1.2.3.4" }, "https://ccn.example.com");
  await c.callTool({ name: "send_message", arguments: { session: LIVE, text: "a" } });
  expect(live.sent.at(-1)).toBe("from agent:cid.access via vm\n\na");
  await c.callTool({ name: "send_message", arguments: { session: LIVE, text: "b", as: "lead" } });
  expect(live.sent.at(-1)).toBe("from agent:vm/lead via vm\n\nb");
});

test("/mcp refuses callers without authorization before any MCP handling", async () => {
  const keys = await makeKeys();
  const identity = new AccessIdentity({ teamDomain: "t.cloudflareaccess.com", aud: "aud", fetchJwks: async () => keys.jwks });
  const { app } = harness({ identity });
  const init = { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "x", version: "0" } } };
  const headers = { "content-type": "application/json", accept: "application/json, text/event-stream" };
  // Cloudflare を通ったのに JWT が無い
  const noJwt = await app.fetch(new Request("https://ccn.example.com/mcp", { method: "POST", headers: { ...headers, "cf-connecting-ip": "1.2.3.4" }, body: JSON.stringify(init) }));
  expect(noJwt.status).toBe(401);
  // 署名の合わない JWT
  const bad = await app.fetch(new Request("https://ccn.example.com/mcp", { method: "POST", headers: { ...headers, "cf-access-jwt-assertion": "a.b.c" }, body: JSON.stringify(init) }));
  expect(bad.status).toBe(403);
  // loopback 以外への JWT の無い要求（DNS rebinding）
  const rebinding = await createApp({ ...harness().deps, identity: new HeaderIdentity() }).fetch(new Request("http://evil.example/mcp", { method: "POST", headers, body: JSON.stringify(init) }));
  expect(rebinding.status).toBe(401);
});

test("/mcp keeps the CSRF guard and answers only POST", async () => {
  const deny: Identity = new HeaderIdentity();
  const { app } = harness({ identity: deny });
  const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" });
  const cross = await app.fetch(new Request("http://127.0.0.1:4330/mcp", { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream", origin: "https://evil.example" }, body }));
  expect(cross.status).toBe(403);
  expect((await app.fetch(new Request("http://127.0.0.1:4330/mcp"))).status).toBe(405);
  expect((await app.fetch(new Request("http://127.0.0.1:4330/mcp", { method: "DELETE" }))).status).toBe(405);
});

test("create_session without cwd and prompt starts an idle session in the lobby", async () => {
  const lobby = mkdtempSync(join(tmpdir(), "ccn-mcp-lobby-"));
  const { app, starts } = harness({ lobby });
  const c = await connect(app);
  const r = json(await c.callTool({ name: "create_session", arguments: {} }));
  expect(r).toMatchObject({ peer: "vm", id: "new1", cwd: realpathSync(lobby), parent: "local", cursor: 0 });
  expect(starts[0]!.opts.cwd).toBe(realpathSync(lobby));
  expect(starts[0]!.opts.prompt).toBeUndefined();
  const { tools } = await c.listTools();
  const desc = tools.find((t) => t.name === "create_session")!.description!;
  expect(desc).toContain("lobby");
  expect(desc).toContain("子: <peer>/<sessionId>");
});

test("list_places returns the lobby, roots and recent directories without the lobby itself", async () => {
  const { app, store } = harness({ lobby: "/home/u/.local/share/ccn/lobby" });
  const inLobby = new FakeDriver({ id: "lob1", capabilities: caps(true) });
  inLobby.cwd = "/home/u/.local/share/ccn/lobby";
  store.add(inLobby);
  const c = await connect(app);
  const r = json(await c.callTool({ name: "list_places", arguments: {} }));
  expect(r.lobby).toBe("/home/u/.local/share/ccn/lobby");
  expect(r.roots).toEqual(["/home/u", tmpdir()]);
  expect(r.recent.map((x: { cwd: string }) => x.cwd).sort()).toEqual(["/home/u/proj", "/home/u/x"]);
  expect(r.note).toBeUndefined();
});

test("create_session without a prompt on an older peer explains that it needs cwd and prompt", async () => {
  const registry = new StaticRegistry([{ name: "vm", url: "https://ccn-vm.fybe.jp", status: "healthy", self: true }, { name: "old", url: "https://ccn-old.fybe.jp", status: "healthy", self: false }]);
  const oldFetch = (async () => Response.json({ error: "prompt or resume is required" }, { status: 400 })) as unknown as typeof fetch;
  const { app } = harness({ registry, relay: new Relay({ registry, nodeName: "vm", serviceToken: { clientId: "c", clientSecret: "s" }, fetchFn: oldFetch }) });
  const c = await connect(app);
  const r = await c.callTool({ name: "create_session", arguments: { peer: "old", cwd: "/r" } });
  expect(r.isError).toBe(true);
  expect(text(r)).toContain("older ccn");
});
