// 一覧の絞り込み、ETag、変化を流す SSE（#24）
import { test, expect } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type Deps } from "../../src/api/app";
import { SessionStore } from "../../src/sessions/store";
import { FakeDriver } from "../helpers/fake-driver";
import { HeaderIdentity } from "../../src/identity/identity";
import type { AgentInfo } from "../../src/engine/agents";
import { StaticRegistry } from "../../src/registry/registry";
import { Relay } from "../../src/relay/relay";
import type { SessionSummary } from "../../src/sessions/types";

const caps = (on: boolean) => ({ send: on, permissions: on, interrupt: on, stop: on, events: on });
const term: AgentInfo = { pid: 77, cwd: "/home/u/t", kind: "interactive", startedAt: 2, sessionId: "term1", status: "busy" };
const old1: SessionSummary = { id: "old1", kind: "node", capabilities: caps(false), cwd: "/home/u/x", state: "exited", startedAt: 1, lastActivityAt: 1 };

function harness(o: { agents?: () => Promise<AgentInfo[]>; tickMs?: number } = {}) {
  const store = new SessionStore();
  const live = new FakeDriver({ id: "live1", capabilities: caps(true) });
  store.add(live);
  let histCalls = 0;
  let agentCalls = 0;
  const registry = new StaticRegistry([{ name: "vm", url: "https://vm.cc.fybe.jp", status: "healthy", self: true }]);
  const deps: Deps = {
    nodeName: "vm", roots: ["/home/u"], lobby: join(tmpdir(), "ccn-test-lobby"), store, identity: new HeaderIdentity(),
    history: { list: async () => { histCalls++; return [old1]; } } as unknown as Deps["history"],
    startNode: async () => { throw new Error("no"); },
    agents: async () => { agentCalls++; return o.agents ? o.agents() : [term]; },
    terminalFor: (a) => { const d = new FakeDriver({ id: a.sessionId!, capabilities: { send: true, permissions: false, interrupt: false, stop: false, events: false }, kind: "terminal" }); d.state = a.status === "busy" ? "running" : "idle"; return d; },
    host: async () => ({ claudeVersion: "x", load: [0] }),
    registry, relay: new Relay({ registry, nodeName: "vm" }), appRoot: join(import.meta.dir, "..", ".."),
    listWatch: { tickMs: o.tickMs ?? 30, debounceMs: 5 },
  };
  return { app: createApp(deps), store, live, hist: () => histCalls, agentCalls: () => agentCalls };
}
const req = (path: string, init?: RequestInit) => new Request(`http://127.0.0.1${path}`, init);

// SSE の枠を1つずつ読む
function frames(res: Response) {
  const reader = res.body!.getReader();
  const dec = new TextDecoder();
  let buf = "";
  // 時間切れで捨てた読みの結果を落とさないよう、読みかけの Promise を次の呼び出しに持ち越す
  let pending: ReturnType<typeof reader.read> | undefined;
  return {
    async next(ms = 1000): Promise<{ id?: string; event?: string; data?: unknown } | "timeout"> {
      const deadline = Date.now() + ms;
      for (;;) {
        const i = buf.indexOf("\n\n");
        if (i >= 0) {
          const f = buf.slice(0, i); buf = buf.slice(i + 2);
          if (f.startsWith(":")) continue;
          const g: { id?: string; event?: string; data?: unknown } = {};
          for (const l of f.split("\n")) {
            if (l.startsWith("id: ")) g.id = l.slice(4);
            else if (l.startsWith("event: ")) g.event = l.slice(7);
            else if (l.startsWith("data: ")) g.data = JSON.parse(l.slice(6));
          }
          return g;
        }
        const left = deadline - Date.now();
        if (left <= 0) return "timeout";
        pending ??= reader.read();
        const r = await Promise.race([pending, Bun.sleep(left).then(() => "timeout" as const)]);
        if (r === "timeout") return "timeout";
        pending = undefined;
        if (r.done) throw new Error("stream ended");
        buf += dec.decode(r.value, { stream: true });
      }
    },
    close: () => reader.cancel().catch(() => {}),
  };
}
const ids = (d: unknown) => (d as SessionSummary[]).map((s) => s.id).sort();

test("?state=live leaves out exited sessions and does not read the history", async () => {
  const h = harness();
  const r = await h.app.fetch(req("/api/sessions?state=live"));
  expect(ids(await r.json())).toEqual(["live1", "term1"]);
  expect(h.hist()).toBe(0);
  expect(ids(await (await h.app.fetch(req("/api/sessions?state=exited"))).json())).toEqual(["old1"]);
  expect(ids(await (await h.app.fetch(req("/api/sessions?state=running,idle"))).json())).toEqual(["live1", "term1"]);
  expect(ids(await (await h.app.fetch(req("/api/sessions"))).json())).toEqual(["live1", "old1", "term1"]);
});

test("an unknown state is 400 and names the accepted values", async () => {
  const r = await harness().app.fetch(req("/api/sessions?state=busy"));
  expect(r.status).toBe(400);
  expect((await r.json()).states).toContain("live");
});

test("the list carries an ETag and answers 304 without a body when If-None-Match matches", async () => {
  const h = harness();
  const a = await h.app.fetch(req("/api/sessions?state=live"));
  const etag = a.headers.get("etag")!;
  expect(etag).toMatch(/^"[0-9a-f]+"$/);
  const b = await h.app.fetch(req("/api/sessions?state=live", { headers: { "if-none-match": etag } }));
  expect(b.status).toBe(304);
  expect(await b.text()).toBe("");
  expect(b.headers.get("etag")).toBe(etag);
  expect((await h.app.fetch(req("/api/sessions?state=live", { headers: { "if-none-match": `W/${etag}` } }))).status).toBe(304);
  // 変われば 200 で新しい ETag
  h.live.setState("idle");
  const c = await h.app.fetch(req("/api/sessions?state=live", { headers: { "if-none-match": etag } }));
  expect(c.status).toBe(200);
  expect(c.headers.get("etag")).not.toBe(etag);
});

test("the stream sends the list first, then only when it changes; the event id is the list's ETag", async () => {
  // tick を長くして、台帳の変化が tick を待たずに届くことを見る
  const h = harness({ tickMs: 60_000 });
  const etag = (await h.app.fetch(req("/api/sessions?state=live"))).headers.get("etag");
  const res = await h.app.fetch(req("/api/sessions/stream?state=live"));
  expect(res.headers.get("content-type")).toContain("text/event-stream");
  const f = frames(res);
  try {
    const first = await f.next();
    expect(first).toMatchObject({ event: "sessions", id: etag! });
    expect(ids((first as { data: unknown }).data)).toEqual(["live1", "term1"]);
    expect(await f.next(200)).toBe("timeout");
    // 台帳の状態の変化はすぐ届く
    h.live.setState("waiting_permission");
    h.live.push({ type: "permission_request", data: {} });
    const second = await f.next();
    expect((second as { data: SessionSummary[] }).data.find((s) => s.id === "live1")!.state).toBe("waiting_permission");
    expect(h.hist()).toBe(0);
  } finally { await f.close(); }
});

test("terminal sessions are re-read on the tick and their changes are streamed", async () => {
  let agents: AgentInfo[] = [term];
  const h = harness({ agents: async () => agents });
  const f = frames(await h.app.fetch(req("/api/sessions/stream?state=live")));
  try {
    expect(ids(((await f.next()) as { data: unknown }).data)).toEqual(["live1", "term1"]);
    agents = [{ ...term, status: "idle" }, { ...term, pid: 78, sessionId: "term2" }];
    const next = (await f.next()) as { data: SessionSummary[] };
    expect(ids(next.data)).toEqual(["live1", "term1", "term2"]);
    expect(next.data.find((s) => s.id === "term1")!.state).toBe("idle");
  } finally { await f.close(); }
});

test("nothing is streamed while nothing changes, even across ticks", async () => {
  const h = harness();
  const f = frames(await h.app.fetch(req("/api/sessions/stream?state=live")));
  try {
    await f.next();
    expect(await f.next(200)).toBe("timeout");
    expect(h.agentCalls()).toBeGreaterThan(2);
  } finally { await f.close(); }
});

test("Last-Event-ID equal to the current ETag skips the first list", async () => {
  const h = harness();
  const etag = (await h.app.fetch(req("/api/sessions?state=live"))).headers.get("etag")!;
  const f = frames(await h.app.fetch(req("/api/sessions/stream?state=live", { headers: { "last-event-id": etag } })));
  try {
    expect(await f.next(150)).toBe("timeout");
    h.live.setState("idle");
    h.live.push({ type: "result", data: {} });
    expect((await f.next()) as object).toMatchObject({ event: "sessions" });
  } finally { await f.close(); }
});

test("claude agents is not run while nobody watches, and stops after the last watcher leaves", async () => {
  const h = harness();
  await Bun.sleep(100);
  expect(h.agentCalls()).toBe(0);
  const a = frames(await h.app.fetch(req("/api/sessions/stream?state=live")));
  const b = frames(await h.app.fetch(req("/api/sessions/stream")));
  await a.next(); await b.next();
  await Bun.sleep(150);
  const during = h.agentCalls();
  // 2本で tick を共有する（tick 30ms で 150ms なら多くて6回前後）
  expect(during).toBeGreaterThan(1);
  expect(during).toBeLessThan(10);
  await a.close(); await b.close();
  await Bun.sleep(50);
  const after = h.agentCalls();
  await Bun.sleep(150);
  expect(h.agentCalls()).toBe(after);
});

test("an unknown state on the stream is 400", async () => {
  expect((await harness().app.fetch(req("/api/sessions/stream?state=nope"))).status).toBe(400);
});

test("while the stream is watched, list and detail requests do not run claude agents on their own", async () => {
  const h = harness({ tickMs: 60_000 });
  const f = frames(await h.app.fetch(req("/api/sessions/stream?state=live")));
  try {
    await f.next();
    const base = h.agentCalls();
    await Bun.sleep(30); // 要求の側の2秒のキャッシュが切れたことにする代わりに、何度も呼ぶ
    for (let i = 0; i < 5; i++) {
      await h.app.fetch(req("/api/sessions?state=live"));
      await h.app.fetch(req("/api/sessions/term1"));
    }
    expect(h.agentCalls()).toBe(base);
  } finally { await f.close(); }
});

test("leaving and coming back while a slow refresh is running does not start a second tick chain", async () => {
  let release: (() => void) | undefined;
  let slow = false;
  const h = harness({ agents: async () => { if (slow) await new Promise<void>((r) => { release = r; }); return [term]; } });
  const a = frames(await h.app.fetch(req("/api/sessions/stream?state=live")));
  await a.next();
  slow = true;
  await Bun.sleep(60); // tick（30ms）が始まり、遅い refresh で止まる
  await a.close();
  await Bun.sleep(10);
  slow = false;
  const b = frames(await h.app.fetch(req("/api/sessions/stream?state=live")));
  try {
    await b.next();
    release?.();
    const t0 = h.agentCalls();
    await Bun.sleep(300);
    // tick 30ms で 300ms なら1本の連鎖で約10回。2本なら約20回になる
    expect(h.agentCalls() - t0).toBeLessThan(14);
  } finally { await b.close(); }
});
