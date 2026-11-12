// 深さの上限の試験。人が立てたものが0、子が1、孫が2で、孫は子を作れない（src/api/depth.ts）
import { test, expect } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdirSync, realpathSync } from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createApp, type Deps } from "../../src/api/app";
import { SessionStore } from "../../src/sessions/store";
import { FakeDriver } from "../helpers/fake-driver";
import { HeaderIdentity } from "../../src/identity/identity";
import { StaticRegistry } from "../../src/registry/registry";
import { Relay } from "../../src/relay/relay";
import type { Capabilities, SessionSummary } from "../../src/sessions/types";
import { DEPTH_REFUSAL } from "../../src/api/depth";

const caps: Capabilities = { send: true, permissions: true, interrupt: true, stop: true, events: true };
const DIR = realpathSync(tmpdir());
const LOBBY = join(DIR, "ccn-depth-lobby");
mkdirSync(LOBBY, { recursive: true });

class ChildDriver extends FakeDriver {
  constructor(id: string, public parent: string) { super({ id, capabilities: caps }); this.state = "idle"; }
  summary(): SessionSummary { return { ...super.summary(), parent: this.parent }; }
}
const uuid = (n: number) => `${n.toString(16).padStart(8, "0")}-0000-4000-8000-000000000000`;
const agent = (node: string, id: string, role = "lead") => `agent:${node}/${id.slice(0, 8)}/${role}`;

type RelayAnswer = (url: URL) => Response | Promise<Response>;
function harness(opts: { past?: SessionSummary[]; relay?: RelayAnswer } = {}) {
  const store = new SessionStore();
  let n = 0xa0000000;
  const relayed: string[] = [];
  const registry = new StaticRegistry([{ name: "vm", url: "https://ccn-vm.fybe.jp", status: "healthy", self: true }, { name: "pro", url: "https://ccn-pro.fybe.jp", status: "healthy", self: false }]);
  const past = opts.past ?? [];
  const deps: Deps = {
    nodeName: "vm",
    roots: [DIR],
    lobby: LOBBY,
    store,
    identity: new HeaderIdentity(),
    history: {
      list: async () => past,
      messages: async () => ({ messages: [] }),
      count: async () => 0,
      get: async (id: string) => past.find((s) => s.id === id),
    } as unknown as Deps["history"],
    startNode: async (o, caller) => {
      const d = new ChildDriver(o.resume && !o.fork ? o.resume : uuid(n++), caller.id);
      d.cwd = o.cwd;
      return d;
    },
    agents: async () => [],
    terminalFor: () => { throw new Error("no terminals"); },
    host: async () => ({ claudeVersion: "x", load: [0] }),
    registry,
    relay: new Relay({
      registry, nodeName: "vm", serviceToken: { clientId: "i", clientSecret: "s" },
      fetchFn: (async (input: RequestInfo | URL, init?: RequestInit) => {
        const r = new Request(input, init);
        relayed.push(r.url);
        if (!opts.relay) return Response.json({ error: "not found" }, { status: 404 });
        return opts.relay(new URL(r.url));
      }) as typeof fetch,
    }),
    appRoot: join(import.meta.dir, "..", ".."),
  };
  return { app: createApp(deps), store, relayed };
}
const create = (app: ReturnType<typeof harness>["app"], from: string | undefined, body: Record<string, unknown> = {}) =>
  app.fetch(new Request("http://127.0.0.1/api/sessions", {
    method: "POST",
    headers: { "content-type": "application/json", ...(from ? { "x-ccn-from": from, "x-ccn-via": "vm" } : {}) },
    body: JSON.stringify({ cwd: DIR, prompt: "work", ...body }),
  }));
const made = async (r: Response) => { expect(r.status).toBe(201); return (await r.json()) as { id: string; depth: number }; };
const past = (id: string, parent?: string, cwd = DIR): SessionSummary =>
  ({ id, kind: "node", capabilities: { send: false, permissions: false, interrupt: false, stop: false, events: false }, cwd, state: "exited", startedAt: 1, lastActivityAt: 1, parent });

test("a person's session is depth 0, its child 1, the grandchild 2, and the grandchild cannot create a child", async () => {
  const { app } = harness();
  const root = await made(await create(app, undefined));
  expect(root.depth).toBe(0);
  const child = await made(await create(app, agent("vm", root.id)));
  expect(child.depth).toBe(1);
  const grand = await made(await create(app, agent("vm", child.id)));
  expect(grand.depth).toBe(2);
  const r = await create(app, agent("vm", grand.id));
  expect(r.status).toBe(409);
  const b = await r.json();
  expect(b).toEqual({
    error: `${DEPTH_REFUSAL}（呼び手 ${agent("vm", grand.id)} の深さ: 2）`,
    hint: "子を作れるのは深さ1まで（人が立てたセッションが0、その子が1、孫が2）",
    depth: 2,
    limit: 2,
  });
  // terminal: true（PTY）でも同じ所で断る
  expect((await create(app, agent("vm", grand.id), { terminal: true })).status).toBe(409);
  // 一覧と詳細にも刻んだ深さが出る
  const list = (await (await app.fetch(new Request("http://127.0.0.1/api/sessions"))).json()) as SessionSummary[];
  expect(Object.fromEntries(list.map((s) => [s.id, s.depth]))).toEqual({ [root.id]: 0, [child.id]: 1, [grand.id]: 2 });
  expect((await (await app.fetch(new Request(`http://127.0.0.1/api/sessions/${grand.id}`))).json()).depth).toBe(2);
});

test("email, local and callers without a session id count as a person", async () => {
  const { app } = harness();
  expect((await made(await create(app, "ceo@fybe.jp"))).depth).toBe(0);
  expect((await made(await create(app, "local"))).depth).toBe(0);
  expect((await made(await create(app, "agent:vm/lead"))).depth).toBe(0);
});

test("the grandchild stays depth 2 after its parent exits", async () => {
  const { app, store } = harness();
  const root = await made(await create(app, undefined));
  const child = await made(await create(app, agent("vm", root.id)));
  const grand = await made(await create(app, agent("vm", child.id)));
  await store.get(child.id)!.stop();
  await store.get(root.id)!.stop();
  store.remove(root.id);
  expect((await create(app, agent("vm", grand.id))).status).toBe(409);
  // 終わった子から立てようとしても、子の深さ（1）で数える
  expect((await made(await create(app, agent("vm", child.id)))).depth).toBe(2);
});

test("sessions without a stamp (past, before a restart) are traced through their from lines", async () => {
  const A = uuid(0x11111111), B = uuid(0x22222222), C = uuid(0x33333333);
  const { app } = harness({ past: [past(A, "local"), past(B, agent("vm", A)), past(C, agent("vm", B))] });
  const r = await create(app, agent("vm", C));
  expect(r.status).toBe(409);
  expect((await r.json()).depth).toBe(2);
  expect((await made(await create(app, agent("vm", B)))).depth).toBe(2);
});

test("an unknown caller session counts as a child of depth 0 (let through)", async () => {
  const { app } = harness();
  expect((await made(await create(app, agent("vm", uuid(0xdeadbeef))))).depth).toBe(1);
});

test("a session in the lobby does not count as a level, and a grandchild cannot start a lobby", async () => {
  const { app } = harness();
  const root = await made(await create(app, undefined));
  const child = await made(await create(app, agent("vm", root.id)));
  // 子が受け口に頼む: 受け口は深さ2、受け口が立てる子も深さ2
  const lobby = await made(await create(app, agent("vm", child.id), { cwd: undefined, prompt: undefined }));
  expect(lobby.depth).toBe(2);
  const viaLobby = await made(await create(app, agent("vm", lobby.id, "lobby")));
  expect(viaLobby.depth).toBe(2);
  // 受け口から受け口へつないでも深さは増えも減りもしない
  const lobby2 = await made(await create(app, agent("vm", lobby.id, "lobby"), { cwd: LOBBY }));
  expect(lobby2.depth).toBe(2);
  expect((await create(app, agent("vm", viaLobby.id))).status).toBe(409);
  // 孫は受け口も立てられない
  expect((await create(app, agent("vm", viaLobby.id), { cwd: undefined, prompt: undefined })).status).toBe(409);
});

test("resume keeps the original depth even when a person resumes", async () => {
  const A = uuid(0x11111111), B = uuid(0x22222222), C = uuid(0x33333333);
  const { app } = harness({ past: [past(A, "local"), past(B, agent("vm", A)), past(C, agent("vm", B))] });
  const r = await made(await create(app, "local", { resume: C, prompt: undefined }));
  expect(r).toMatchObject({ id: C, depth: 2 });
  expect((await create(app, agent("vm", C))).status).toBe(409);
  // fork も元の深さを引き継ぐ
  const f = await made(await create(app, "local", { resume: B, fork: true, prompt: undefined }));
  expect(f.depth).toBe(1);
});

test("a caller on another node is looked up through the relay", async () => {
  const S = uuid(0x44444444);
  let answer: Response | (() => never) = Response.json({ found: true, id: S, depth: 2, lobby: false, known: true });
  const { app, relayed } = harness({ relay: () => (typeof answer === "function" ? answer() : answer) });
  const r = await create(app, agent("pro", S));
  expect(r.status).toBe(409);
  expect((await r.json()).error).toContain(`呼び手 ${agent("pro", S)} の深さ: 2`);
  const u = new URL(relayed.at(-1)!);
  expect(u.origin + u.pathname).toBe("https://ccn-pro.fybe.jp/api/depth");
  expect(u.searchParams.get("session")).toBe(S.slice(0, 8));
  answer = Response.json({ found: true, id: S, depth: 1, lobby: false, known: true });
  expect((await made(await create(app, agent("pro", S)))).depth).toBe(2);
  // 古い版（404）、見つからない、届かないときは通す。子は少なくとも深さ1
  answer = Response.json({ error: "not found" }, { status: 404 });
  expect((await made(await create(app, agent("pro", S)))).depth).toBe(1);
  answer = Response.json({ found: false });
  expect((await made(await create(app, agent("pro", S)))).depth).toBe(1);
  answer = () => { throw new Error("down"); };
  expect((await made(await create(app, agent("pro", S)))).depth).toBe(1);
});

test("a session whose parent lives on another node is traced there", async () => {
  const P = uuid(0x55555555), C = uuid(0x66666666);
  const { app } = harness({ past: [past(C, agent("pro", P))], relay: (u) => Response.json(u.searchParams.get("session") === P.slice(0, 8) ? { found: true, id: P, depth: 1, lobby: false, known: true } : { found: false }) });
  expect((await create(app, agent("vm", C))).status).toBe(409);
});

test("GET /api/depth answers for this node's sessions", async () => {
  const { app } = harness();
  const root = await made(await create(app, undefined));
  const child = await made(await create(app, agent("vm", root.id)));
  const get = (q: string) => app.fetch(new Request(`http://127.0.0.1/api/depth?${q}`));
  expect(await (await get(`session=${child.id.slice(0, 8)}`)).json()).toEqual({ found: true, id: child.id, depth: 1, lobby: false, known: true });
  expect(await (await get(`session=${uuid(0xfeedface).slice(0, 8)}`)).json()).toEqual({ found: false });
  expect((await get("session=xyz")).status).toBe(400);
});

test("MCP create_session returns the same refusal and the depth", async () => {
  const { app } = harness();
  const transport = new StreamableHTTPClientTransport(new URL("http://127.0.0.1:4330/mcp"), { fetch: ((i: RequestInfo | URL, init?: RequestInit) => app.fetch(new Request(i, init))) as typeof fetch });
  const c = new Client({ name: "test", version: "0" });
  await c.connect(transport);
  const call = async (args: Record<string, unknown>) => {
    const r = await c.callTool({ name: "create_session", arguments: { cwd: DIR, prompt: "work", ...args } });
    return { isError: !!r.isError, text: (r.content as Array<{ text: string }>)[0]!.text };
  };
  const root = JSON.parse((await call({})).text);
  expect(root.depth).toBe(0);
  const child = JSON.parse((await call({ as: "lead", as_session: root.id })).text);
  expect(child.depth).toBe(1);
  const grand = JSON.parse((await call({ as: "lead", as_session: child.id })).text);
  expect(grand.depth).toBe(2);
  const r = await call({ as: "lead", as_session: grand.id });
  expect(r.isError).toBe(true);
  expect(r.text).toBe(`vm POST /api/sessions → 409 ${DEPTH_REFUSAL}（呼び手 ${agent("vm", grand.id)} の深さ: 2） (hint: 子を作れるのは深さ1まで（人が立てたセッションが0、その子が1、孫が2）)`);
});
