// MCP の口の試験。公式 SDK のクライアントを app.fetch につなぎ、initialize、tools/list、tools/call を偽物の Driver で通す
import { test, expect } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
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
import { describePending } from "../../src/sessions/pending";
import { nodeFs, PlacesScanner, type PlacesFs } from "../../src/lobby/places";

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
  expect(tools.map((t) => t.name)).toEqual(["list_peers", "list_sessions", "get_session", "list_places", "create_session", "send_message", "read_messages", "answer_permission", "interrupt_session", "configure_session", "stop_session", "teleport_session"]);
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

// #44: ノードが自動で止めた子は、終わっていても1日は既定の一覧に出し、理由を付ける
test("list_sessions shows recently idle-stopped children by default with their exit reason", async () => {
  const reason = "idle-stop: no activity for 10 min; the conversation is kept, continue with create_session resume=old2";
  const history = {
    list: async () => [
      { id: "old1", kind: "node", capabilities: caps(false), cwd: "/home/u/x", state: "exited", startedAt: 1, lastActivityAt: 1, parent: "agent:lead" },
      { id: "old2", kind: "node", capabilities: caps(false), cwd: "/home/u/y", state: "exited", startedAt: 1, lastActivityAt: Date.now() - 60_000, parent: "agent:lead", exitReason: reason },
      { id: "old3", kind: "node", capabilities: caps(false), cwd: "/home/u/z", state: "exited", startedAt: 1, lastActivityAt: Date.now() - 3 * 86_400_000, parent: "agent:lead", exitReason: reason },
    ],
    messages: async () => ({ messages: [] }), get: async () => undefined, count: async () => 0,
  } as unknown as Deps["history"];
  const { app } = harness({ history });
  const c = await connect(app);
  const ls = json(await c.callTool({ name: "list_sessions", arguments: {} }));
  expect(ls.sessions.map((s: { id: string }) => s.id)).toEqual(["old2", LIVE]); // 新しい順（偽の LIVE は lastActivityAt が 0）
  expect(ls.sessions[0].exitReason).toBe(reason);
  expect(ls.sessions[1].exitReason).toBeUndefined();
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

// #44: 終わった後の messages は jsonl から返すので exited のイベントが無い。詳細の exitReason で理由を出す
test("read_messages on a session the node stopped shows the exit reason", async () => {
  const { app, store } = harness();
  class Stopped extends FakeDriver { summary() { return { ...super.summary(), state: "exited" as const, exitReason: "idle-stop: no activity for 10 min" }; } }
  store.add(new Stopped({ id: "22222222-0000-0000-0000-000000000000", capabilities: caps(false) }));
  const c = await connect(app);
  const out = text(await c.callTool({ name: "read_messages", arguments: { session: "22222222-0000-0000-0000-000000000000", after: 0, wait_seconds: 1 } }));
  expect(out).toContain("[exited] idle-stop: no activity for 10 min");
  expect(out).toMatch(/stop=exited/);
  // 生きていた頃の cursor で読んでも、理由と読み直しの案内の両方が出る
  const late = text(await c.callTool({ name: "read_messages", arguments: { session: "22222222-0000-0000-0000-000000000000", after: 7, wait_seconds: 1 } }));
  expect(late).toContain("[exited] idle-stop: no activity for 10 min");
  expect(late).toContain("[hint] nothing after 7");
});

test("read_messages stops at a permission request and answer_permission answers the only pending one", async () => {
  const { app, live } = harness();
  const input = { command: "rm -rf /tmp/x", description: "Remove x" };
  live.pendingList = [{ requestId: "r1", toolName: "Bash", input, description: "Remove x", createdAt: 0 }];
  live.push({ type: "permission_request", data: { requestId: "r1", toolName: "Bash", input, description: "Remove x" } });
  await settle();
  const c = await connect(app);
  const out = text(await c.callTool({ name: "read_messages", arguments: { session: LIVE } }));
  // 説明文だけでなく command の本文が出る
  expect(out).toContain('[permission] Bash command="rm -rf /tmp/x" ("Remove x") requestId=r1');
  expect(out).toContain('[pending] requestId=r1 Bash command="rm -rf /tmp/x" ("Remove x")');
  expect(out).toContain("stop=permission");
  const denied = await c.callTool({ name: "answer_permission", arguments: { session: LIVE, behavior: "deny" } });
  expect(denied.isError).toBe(true);
  expect(text(denied)).toContain("deny needs a message");
  expect(json(await c.callTool({ name: "answer_permission", arguments: { session: LIVE, behavior: "allow" } }))).toMatchObject({ ok: true, requestId: "r1" });
  expect(live.answers).toEqual([{ requestId: "r1", a: { behavior: "allow" } }]);
});

test("get_session shows each pending request with the same line as the CLI and clips long input values", async () => {
  const { app, live } = harness();
  const content = "x".repeat(5000);
  live.pendingList = [{ requestId: "w1", toolName: "Write", input: { file_path: "/srv/a.txt", content }, description: "/srv/a.txt", createdAt: 0 }];
  const c = await connect(app);
  const g = json(await c.callTool({ name: "get_session", arguments: { session: LIVE } })) as { pending: Array<{ shown: string; input: { content: string } }> };
  expect(g.pending[0]!.shown).toBe(describePending(live.pendingList[0]!));
  expect(g.pending[0]!.shown).toBe('Write file_path="/srv/a.txt"');
  expect(g.pending[0]!.input.content.length).toBeLessThan(2100);
  expect(g.pending[0]!.input.content).toEndWith("…(+3000字)");
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
  const outside = new FakeDriver({ id: "out1", capabilities: caps(true) });
  outside.cwd = "/srv/elsewhere";
  store.add(outside);
  const c = await connect(app);
  const r = json(await c.callTool({ name: "list_places", arguments: {} }));
  expect(r.lobby).toBe("/home/u/.local/share/ccn/lobby");
  expect(r.roots).toEqual(["/home/u", tmpdir()]);
  expect(r.recent.map((x: { cwd: string }) => x.cwd).sort()).toEqual(["/home/u/proj", "/home/u/x"]);
  expect(r.note).toBeUndefined();
});

test("list_places adds candidate places with README, remote and last use, narrowed by query, without secrets", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "ccn-mcp-places-")));
  mkdirSync(join(root, "Documents", "notes", ".git"), { recursive: true });
  writeFileSync(join(root, "Documents", "notes", "README.md"), "# Notes\nメモ\n");
  writeFileSync(join(root, "Documents", "notes", ".git", "config"), '[remote "origin"]\n\turl = https://bob:FAKE-TOKEN-1@github.com/o/notes.git\n');
  mkdirSync(join(root, "other"));
  mkdirSync(join(root, ".ssh"));
  writeFileSync(join(root, ".ssh", "README.md"), "FAKE-SSH-2\n");
  const { app, store } = harness({ roots: [root], home: root, lobby: join(root, "lobby") });
  const used = new FakeDriver({ id: "use1", capabilities: caps(true) });
  used.cwd = join(root, "Documents", "notes", "sub"); // 候補の下で動いたセッションも、その候補を使ったことにする
  const summary = used.summary.bind(used);
  used.summary = () => ({ ...summary(), lastActivityAt: 1234 });
  store.add(used);
  const c = await connect(app);
  const r = json(await c.callTool({ name: "list_places", arguments: {} }));
  expect(r.places.map((p: { path: string }) => p.path)).toEqual([join(root, "Documents", "notes"), join(root, "other")]);
  expect(r.places[0]).toMatchObject({ name: "notes", remote: "https://github.com/o/notes.git", readme: ["# Notes / メモ"], lastUsedAt: 1234 });
  expect(r).toMatchObject({ total: 2, truncated: false, roots: [root] });
  expect(r.recent.map((x: { cwd: string }) => x.cwd)).toContain(join(root, "Documents", "notes", "sub"));
  const q = json(await c.callTool({ name: "list_places", arguments: { query: "notes" } }));
  expect(q.places).toHaveLength(1);
  expect(q.places[0].readme).toEqual(["# Notes", "メモ"]);
  const all = JSON.stringify(r) + JSON.stringify(q);
  expect(all).not.toContain("FAKE-");
  expect(all).not.toContain("bob");
});

test("list_places on an older peer without /api/places keeps lobby, roots and recent and says so in note", async () => {
  const registry = new StaticRegistry([{ name: "vm", url: "https://ccn-vm.fybe.jp", status: "healthy", self: true }, { name: "old", url: "https://ccn-old.fybe.jp", status: "healthy", self: false }]);
  const oldFetch = (async (input: RequestInfo | URL) => {
    const path = new URL(new Request(input).url).pathname;
    if (path === "/api/host") return Response.json({ name: "old", roots: ["/r"], lobby: "/r/lobby" });
    if (path === "/api/sessions") return Response.json([{ id: "99999999-0000-0000-0000-000000000000", kind: "node", state: "idle", cwd: "/r/a", lastActivityAt: 5 }]);
    return Response.json({ error: "not found" }, { status: 404 });
  }) as unknown as typeof fetch;
  const { app } = harness({ registry, relay: new Relay({ registry, nodeName: "vm", serviceToken: { clientId: "c", clientSecret: "s" }, fetchFn: oldFetch }) });
  const c = await connect(app);
  const r = await c.callTool({ name: "list_places", arguments: { peer: "old" } });
  expect(r.isError).toBeFalsy();
  const b = json(r);
  expect(b).toMatchObject({ peer: "old", lobby: "/r/lobby", roots: ["/r"], recent: [{ cwd: "/r/a", lastActivityAt: 5 }] });
  expect(b.places).toBeUndefined();
  expect(b.note).toContain("older ccn without places");
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

// 止まるディレクトリのある places。走査は1つにまとまり、上限で打ち切られ、MCP と API に partial と note で伝わる
test("list_places and /api/places return partial places with a note when a folder does not answer, sharing one scan", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "ccn-mcp-places-hang-")));
  mkdirSync(join(root, "ok"));
  mkdirSync(join(root, "stuck"));
  const stuck = join(root, "stuck");
  let readdirs = 0;
  const fs: PlacesFs = { ...nodeFs, readdir: (p) => { if (p === stuck) { readdirs++; return new Promise(() => {}); } return nodeFs.readdir(p); } };
  const scanner = new PlacesScanner({ fs, deadlineMs: 1000, opMs: 100, cacheMs: 0 });
  const { app } = harness({ roots: [root], home: root, lobby: join(root, "lobby"), places: scanner });
  const get = () => app.fetch(new Request("http://127.0.0.1:4330/api/places")).then((r) => r.json() as Promise<Record<string, unknown>>);
  const started = Date.now();
  const [a, b] = await Promise.all([get(), get()]);
  expect(Date.now() - started).toBeLessThan(800);
  expect(scanner.scans).toBe(1);
  expect(a).toEqual(b);
  expect(a).toMatchObject({ partial: true, unreadable: [stuck], total: 1 });
  expect((a.places as Array<{ name: string }>).map((p) => p.name)).toEqual(["ok"]);
  expect(String(a.note)).toContain(stuck);
  const c = await connect(app);
  const r = json(await c.callTool({ name: "list_places", arguments: {} }));
  expect(r).toMatchObject({ partial: true, unreadable: [stuck] });
  expect(r.note).toContain("partial");
  expect(scanner.scans).toBe(2);
  expect(readdirs).toBe(1); // 2回目の走査では止まったディレクトリを開かない
});

test("create_session terminal=true asks the node for a pty session with name and size", async () => {
  const { app, sent } = harness();
  const c = await connect(app);
  const r = json(await c.callTool({ name: "create_session", arguments: { peer: "pro", cwd: "/r", terminal: true, name: "town-1", cols: 100, rows: 30, as: "town", as_session: "abcd1234-0000" } }));
  const post = sent.find((s) => s.method === "POST")!;
  expect(JSON.parse(post.body)).toEqual({ cwd: "/r", terminal: true, name: "town-1", cols: 100, rows: 30 });
  expect(post.headers.get("x-ccn-from")).toBe("agent:vm/abcd1234/town");
  // 偽の相手は kind を返さない（terminal を知らない古い版）ので、その旨を伝える
  expect(r.note).toContain("older ccn without terminal sessions");
});

test("create_session terminal=true locally starts a pty session and returns its kind", async () => {
  const pty = new FakeDriver({ id: "pty1", capabilities: { ...caps(true), terminal: true }, kind: "pty" });
  const calls: unknown[] = [];
  const { app } = harness({ startPty: (async (opts: unknown) => { calls.push(opts); return pty; }) as unknown as Deps["startPty"] });
  const c = await connect(app);
  const r = json(await c.callTool({ name: "create_session", arguments: { cwd: realpathSync(tmpdir()), prompt: "task", terminal: true } }));
  expect(r).toMatchObject({ id: "pty1", kind: "pty", parent: "local" });
  expect(r.note).toBeUndefined();
  expect(calls[0]).toMatchObject({ prompt: "from local via vm\n\ntask" });
});

test("create_session succeed=true は fork も付けて頼む。古い版の相手は succeeded を返さないので、ただの fork だったと伝える", async () => {
  const { app, sent } = harness();
  const c = await connect(app);
  const r = json(await c.callTool({ name: "create_session", arguments: { peer: "pro", resume: "old-1", succeed: true, terminal: true, as: "meta", as_session: "abcd1234-0000" } }));
  const post = sent.find((s) => s.method === "POST")!;
  expect(JSON.parse(post.body)).toEqual({ terminal: true, resume: "old-1", fork: true, succeed: true });
  expect(r.note).toContain("older ccn without succeed");
  expect(r.succeeded).toBeUndefined();
  // 古い版は parent を返さないので、呼び手を返す
  expect(r.parent).toBe("agent:vm/abcd1234/meta");
});

test("create_session succeed=true は、ノードが返した parent、アカウント、succeeded をそのまま返す。断りの code と次に使えるアカウントも文に入る", async () => {
  let none = false;
  const forked = "22222222-0000-4000-8000-000000000000";
  const { app, live } = harness({
    account: async () => (none ? { none: { nextAvailable: { account: "b", at: 1794921000000 } } } : { name: "a" }),
    teleport: { fns: { forkSession: async () => ({ sessionId: forked }), deleteSession: async () => {} } } as unknown as Deps["teleport"],
    startNode: (async (opts: { resume?: string; cwd: string }) => { const d = new FakeDriver({ id: opts.resume ?? "new1", capabilities: caps(true) }); d.cwd = opts.cwd; d.state = "idle"; return d; }) as unknown as Deps["startNode"],
  });
  live.state = "idle";
  live.cwd = realpathSync(tmpdir()); // 後継は前任の cwd を継ぐので、実在する場所にする
  const c = await connect(app);
  none = true;
  const refused = await c.callTool({ name: "create_session", arguments: { resume: LIVE, succeed: true, as: "meta", as_session: "abcd1234-0000" } });
  expect(refused.isError).toBe(true);
  expect(text(refused)).toContain("409");
  expect(text(refused)).toContain("code=no_account");
  expect(text(refused)).toContain('nextAvailable={"account":"b","at":1794921000000}');
  none = false;
  const r = json(await c.callTool({ name: "create_session", arguments: { resume: LIVE, succeed: true, as: "meta", as_session: "abcd1234-0000" } }));
  // 前任（LIVE）は parent を持たないので、後継の parent は呼び手になる
  expect(r).toMatchObject({ id: forked, parent: "agent:vm/abcd1234/meta", succeeded: { from: LIVE, stopped: true, adopted: [] } });
  expect(r.note).toBeUndefined();
  const again = await c.callTool({ name: "create_session", arguments: { resume: LIVE, succeed: true } });
  expect(text(again)).toContain("code=already_succeeded");
  expect(text(again)).toContain(`successor=${forked}`);
});

// pty を resume で付け直したセッション（ノードの再起動の後に Claude Town が付け直すもの）。
// 付ける前の会話は jsonl から履歴の位置で返し、付けた後は台帳の seq で返す。番号は会話の件数から続く
const PTY = "77777777-aaaa-bbbb-cccc-dddddddddddd";
function ptyHarness(historyLen: number) {
  const past = Array.from({ length: historyLen }, (_, i) => i === historyLen - 1
    ? { type: "assistant", uuid: `h${i}`, message: { role: "assistant", content: [{ type: "text", text: "old reply" }] } }
    : { type: "user", uuid: `h${i}`, message: { role: "user", content: `old ${i}` } });
  const pty = new FakeDriver({ id: PTY, capabilities: { ...caps(true), terminal: true }, kind: "pty" });
  pty.state = "idle";
  pty.cwd = realpathSync(tmpdir());
  const counted: string[] = [];
  const h = harness({
    startPty: (async () => pty) as unknown as Deps["startPty"],
    history: {
      list: async () => [],
      get: async () => undefined,
      count: async (id: string) => { counted.push(id); return id === PTY ? past.length : 0; },
      messages: async (id: string, after = 0, limit = 200) => {
        const m = id === PTY ? past.slice(after, after + limit) : [];
        return { messages: m, next: m.length ? after + m.length : undefined };
      },
    } as unknown as Deps["history"],
  });
  return { ...h, pty, past, counted };
}
const get = async (app: { fetch: (r: Request) => Promise<Response> }, path: string) => (await app.fetch(new Request(`http://127.0.0.1${path}`))).json() as Promise<any>;

test("a resumed pty session returns the earlier conversation from history, then the live events, with seq after the history count", async () => {
  const { app, pty, counted } = ptyHarness(250);
  const res = await app.fetch(new Request("http://127.0.0.1/api/sessions", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ cwd: pty.cwd, terminal: true, resume: PTY }) }));
  const created = await res.json() as { cursor: number; kind: string };
  expect(created).toMatchObject({ kind: "pty", cursor: 250 });
  expect(counted).toEqual([PTY]);
  pty.push({ type: "user", data: { type: "user", message: { role: "user", content: "new" } } });
  pty.push({ type: "assistant", data: { type: "assistant", message: { content: [{ type: "text", text: "new reply" }] } } });
  await settle();
  const p1 = await get(app, `/api/sessions/${PTY}/messages?after=0`);
  expect(p1.messages.length).toBe(200);
  expect(p1.messages[0]).toMatchObject({ uuid: "h0" });
  expect(p1.messages.every((m: { seq?: number }) => m.seq === undefined)).toBe(true);
  expect(p1.next).toBe(200);
  // 履歴の残りを読み切ったページには、続けて台帳のイベントが入る
  const p2 = await get(app, `/api/sessions/${PTY}/messages?after=200`);
  expect(p2.messages.length).toBe(52);
  expect(p2.messages[49]).toMatchObject({ uuid: "h249" });
  expect(p2.messages.slice(50).map((m: { seq: number }) => m.seq)).toEqual([251, 252]);
  expect(p2.next).toBe(252);
  const p3 = await get(app, `/api/sessions/${PTY}/messages?after=252`);
  expect(p3.messages).toEqual([]);
  expect(p3.next).toBeUndefined();
  // epoch（番号の印）は、履歴だけのページ、つなぎのページ、空のページで同じ
  expect(typeof p1.epoch).toBe("string");
  expect([p2.epoch, p3.epoch]).toEqual([p1.epoch, p1.epoch]);
  expect((await get(app, `/api/sessions/${PTY}`)).cursor).toBe(252);
});

test("a new pty session (no resume) does not read the history and counts from 0 as before", async () => {
  const { app, pty, counted } = ptyHarness(3);
  const res = await app.fetch(new Request("http://127.0.0.1/api/sessions", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ cwd: pty.cwd, terminal: true }) }));
  expect(await res.json()).toMatchObject({ kind: "pty", cursor: 0 });
  expect(counted).toEqual([]);
  pty.push({ type: "assistant", data: { type: "assistant", message: { content: [{ type: "text", text: "hi" }] } } });
  await settle();
  const p = await get(app, `/api/sessions/${PTY}/messages?after=0`);
  expect(p.messages.map((m: { seq: number }) => m.seq)).toEqual([1]);
});

test("create_session resume on a pty returns the history count as cursor, and send_message then read_messages picks up only the new reply", async () => {
  const { app, pty } = ptyHarness(3);
  const c = await connect(app);
  const r = json(await c.callTool({ name: "create_session", arguments: { cwd: pty.cwd, terminal: true, resume: PTY } }));
  expect(r).toMatchObject({ id: PTY, kind: "pty", cursor: 3 });
  // cursor から読むと、前の会話の返事を今の返事として拾わない
  const idle = text(await c.callTool({ name: "read_messages", arguments: { session: PTY, after: r.cursor, wait_seconds: 2 } }));
  expect(idle).not.toContain("old reply");
  expect(idle).toMatch(/stop=timeout state=idle pending=0 cursor=3 /);
  const sent = json(await c.callTool({ name: "send_message", arguments: { session: PTY, text: "go" } }));
  expect(sent.cursor).toBe(3);
  expect(pty.sent).toEqual(["from local via vm\n\ngo"]);
  pty.push({ type: "user", data: { type: "user", message: { role: "user", content: "from local via vm\n\ngo" } } });
  pty.push({ type: "assistant", data: { type: "assistant", message: { content: [{ type: "text", text: "new reply" }] } } });
  pty.push({ type: "result", data: { type: "result", subtype: "success", result: "new reply" } });
  await settle();
  const out = text(await c.callTool({ name: "read_messages", arguments: { session: PTY, after: sent.cursor, wait_seconds: 5 } }));
  expect(out).toContain("new reply");
  expect(out).not.toContain("old reply");
  expect(out).toMatch(/stop=result .* cursor=6 /);
  // after=0 からは前の会話も読める
  const all = text(await c.callTool({ name: "read_messages", arguments: { session: PTY, after: 0, wait_seconds: 2 } }));
  expect(all).toContain("old reply");
  expect(all).toContain("new reply");
  expect(all).toMatch(/stop=result .* cursor=6 /);
});

test("a resumed pty still stops read_messages at a permission request from the ledger", async () => {
  const { app, pty } = ptyHarness(3);
  const c = await connect(app);
  const r = json(await c.callTool({ name: "create_session", arguments: { cwd: pty.cwd, terminal: true, resume: PTY } }));
  const input = { command: "rm -rf /tmp/x", description: "Remove x" };
  pty.state = "waiting_permission";
  pty.pendingList = [{ requestId: "r1", toolName: "Bash", input, description: "Remove x", createdAt: 0 }];
  pty.push({ type: "permission_request", data: { requestId: "r1", toolName: "Bash", input, description: "Remove x" } });
  await settle();
  const out = text(await c.callTool({ name: "read_messages", arguments: { session: PTY, after: r.cursor, wait_seconds: 2 } }));
  expect(out).not.toContain("old reply");
  expect(out).toContain("[permission] Bash");
  expect(out).toMatch(/stop=permission state=waiting_permission pending=1 cursor=4 /);
});

// ノードの再起動をまたいで cursor を持つ読み手（Claude Town の会話）。再起動の前の末尾は seq 3（user、assistant、result）、
// jsonl には user と assistant の2件しか無いので、付け直した後の境界は 2 になり、前の cursor 3 で読むと seq 3 が落ちる。
// messages の epoch が変わったことで読み手が気づき、after=0 から読み直すと欠けも重なりも無い
test("messages carries an epoch that changes across a node restart, so a reader holding an old cursor can re-read from 0 without gaps", async () => {
  const create = (app: { fetch: (r: Request) => Promise<Response> }, cwd: string, resume?: string) =>
    app.fetch(new Request("http://127.0.0.1/api/sessions", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ cwd, terminal: true, ...(resume ? { resume } : {}) }) }));
  const turn = (pty: FakeDriver, n: number) => {
    pty.push({ type: "user", data: { type: "user", message: { role: "user", content: `ping ${n}` } } });
    pty.push({ type: "assistant", data: { type: "assistant", message: { content: [{ type: "text", text: `PONG${n}` }] } } });
    pty.push({ type: "result", data: { type: "result", subtype: "success", result: `PONG${n}` } });
  };
  // 再起動の前のノード
  const a = ptyHarness(0);
  await create(a.app, a.pty.cwd);
  turn(a.pty, 1);
  await settle();
  const before = await get(a.app, `/api/sessions/${PTY}/messages?after=0`);
  expect(before.messages.map((m: { seq: number }) => m.seq)).toEqual([1, 2, 3]);
  const held = { cursor: before.next as number, epoch: before.epoch as string };
  expect(held.cursor).toBe(3);
  // 再起動の後のノード。jsonl には PONG1 の user と assistant の2件
  const b = ptyHarness(2);
  expect(await (await create(b.app, b.pty.cwd, PTY)).json()).toMatchObject({ cursor: 2 });
  turn(b.pty, 2);
  await settle();
  // 前の cursor のまま読むと seq 3（PONG2 を頼んだ user）が落ちる。epoch は前と違う
  const stale = await get(b.app, `/api/sessions/${PTY}/messages?after=${held.cursor}`);
  expect(stale.messages.map((m: { seq: number }) => m.seq)).toEqual([4, 5]);
  expect(stale.epoch).not.toBe(held.epoch);
  // 読み直すと、jsonl の2件と台帳の3件が重ならずにつながる
  const again = await get(b.app, `/api/sessions/${PTY}/messages?after=0`);
  expect(again.epoch).toBe(stale.epoch);
  expect(again.messages.map((m: { uuid?: string; seq?: number }) => m.seq ?? m.uuid)).toEqual(["h0", "h1", 3, 4, 5]);
  expect(again.next).toBe(5);
});

test("resuming the same session again in the same node also changes the epoch; a session read from history has the fixed history epoch", async () => {
  const { app, pty } = ptyHarness(3);
  const create = () => app.fetch(new Request("http://127.0.0.1/api/sessions", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ cwd: pty.cwd, terminal: true, resume: PTY }) }));
  await create();
  const e1 = (await get(app, `/api/sessions/${PTY}/messages?after=0`)).epoch;
  // 終わったものを同じノードで resume し直す（生きているものは 409 で断られる）
  pty.state = "exited";
  expect((await create()).status).toBe(201);
  pty.state = "idle";
  const e2 = (await get(app, `/api/sessions/${PTY}/messages?after=0`)).epoch;
  expect(e2).not.toBe(e1);
  // 終わったセッションは jsonl の位置で返すので、印は決まった値になる
  pty.state = "exited";
  const h = await get(app, `/api/sessions/${PTY}/messages?after=0`);
  expect(h.epoch).toBe("history");
  expect(h.messages.length).toBe(3);
});

// node（SDK）のセッションを resume したときも、pty と同じく前の会話を jsonl から返す。SDK の resume は前の会話を流し直さないので、
// 数えないと after=0 が付け直した後の分しか返さず、epoch が変わって 0 から読み直す読み手から前の会話が消える
test("a resumed node session also returns the earlier conversation from history, and create returns the history count as cursor", async () => {
  const NODE = "88888888-aaaa-bbbb-cccc-dddddddddddd";
  const past = [
    { type: "user", uuid: "n0", message: { role: "user", content: "NODE1" } },
    { type: "assistant", uuid: "n1", message: { role: "assistant", content: [{ type: "text", text: "NODE1" }] } },
  ];
  const d = new FakeDriver({ id: NODE, capabilities: caps(true) });
  d.state = "idle";
  const counted: string[] = [];
  const { app } = harness({
    startNode: async (opts) => { d.cwd = opts.cwd; return d; },
    history: {
      list: async () => [],
      get: async () => undefined,
      count: async (id: string) => { counted.push(id); return id === NODE ? past.length : 0; },
      messages: async (id: string, after = 0, limit = 200) => {
        const m = id === NODE ? past.slice(after, after + limit) : [];
        return { messages: m, next: m.length ? after + m.length : undefined };
      },
    } as unknown as Deps["history"],
  });
  const res = await app.fetch(new Request("http://127.0.0.1/api/sessions", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ cwd: realpathSync(tmpdir()), resume: NODE, prompt: "NODE2" }) }));
  expect(await res.json()).toMatchObject({ id: NODE, kind: "node", cursor: 2 });
  expect(counted).toEqual([NODE]);
  d.push({ type: "assistant", data: { type: "assistant", message: { content: [{ type: "text", text: "NODE2" }] } } });
  await settle();
  const all = await get(app, `/api/sessions/${NODE}/messages?after=0`);
  expect(all.messages.map((m: { uuid?: string; seq?: number }) => m.seq ?? m.uuid)).toEqual(["n0", "n1", 3]);
  // 新しく立てる node（resume 無し）は数えず、0 から
  counted.length = 0;
  const fresh = await app.fetch(new Request("http://127.0.0.1/api/sessions", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ cwd: realpathSync(tmpdir()), prompt: "hi" }) }));
  expect(await fresh.json()).toMatchObject({ cursor: 0 });
  expect(counted).toEqual([]);
});

test("configure_session sends PATCH with model and permissionMode and returns the result (#64)", async () => {
  const { app, store } = harness();
  const live = store.get(LIVE) as unknown as FakeDriver & { configure?: unknown };
  const got: unknown[] = [];
  live.configure = async (c: unknown) => { got.push(c); };
  const c = await connect(app);
  const r = json(await c.callTool({ name: "configure_session", arguments: { session: LIVE, model: "sonnet", permission_mode: "plan" } }));
  expect(got).toEqual([{ model: "sonnet", permissionMode: "plan" }]);
  expect(r).toMatchObject({ ok: true, id: LIVE });
  const none = await c.callTool({ name: "configure_session", arguments: { session: LIVE } });
  expect(none.isError).toBe(true);
  await c.close();
});
