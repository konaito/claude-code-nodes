// 引き継ぎ（succeed）と、作成の応答と一覧のアカウントの試験（src/api/sessions.ts）。
// 後継は前任の parent と depth を継ぎ、前任の子は後継の子になり、前任は止まる。後継が立たなければ何も変えない
import { test, expect } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdirSync, mkdtempSync, realpathSync } from "node:fs";
import { createApp, type Deps } from "../../src/api/app";
import { SessionStore } from "../../src/sessions/store";
import { FakeDriver } from "../helpers/fake-driver";
import { HeaderIdentity, type Caller } from "../../src/identity/identity";
import { StaticRegistry } from "../../src/registry/registry";
import { Relay } from "../../src/relay/relay";
import type { AgentInfo } from "../../src/engine/agents";
import type { Capabilities, Kind, SessionSummary } from "../../src/sessions/types";
import { successorOf, succeededReason } from "../../src/sessions/succeed";

const caps: Capabilities = { send: true, permissions: true, interrupt: true, stop: true, events: true };
const termCaps: Capabilities = { send: true, permissions: false, interrupt: false, stop: false, events: false };
const DIR = realpathSync(tmpdir());
const WORK = mkdtempSync(join(DIR, "ccn-succeed-work-"));
const OTHER = mkdtempSync(join(DIR, "ccn-succeed-other-"));
const LOBBY = join(DIR, "ccn-succeed-lobby");
mkdirSync(LOBBY, { recursive: true });

// parent、終わりの理由、起動の印を持つ偽の Driver。stop は exited のイベントを出す（本物の node と pty と同じ）
class Dr extends FakeDriver {
  parent?: string;
  exitReason?: string;
  permissionMode?: string;
  model?: string;
  title?: string;
  account?: string;
  accountEmail?: string;
  awaiting = false;
  startedResult = true;
  stopFails = false;
  constructor(id: string, o: { kind?: Kind; parent?: string; cwd?: string } = {}) {
    super({ id, capabilities: caps, kind: o.kind ?? "node" });
    this.state = "idle";
    this.parent = o.parent;
    if (o.cwd) this.cwd = o.cwd;
  }
  summary(): SessionSummary {
    return {
      ...super.summary(), parent: this.parent, exitReason: this.exitReason, permissionMode: this.permissionMode, model: this.model, title: this.title,
      ...(this.awaiting ? { awaitingFirst: true } : {}), ...(this.account ? { account: this.account } : {}), ...(this.accountEmail ? { accountEmail: this.accountEmail } : {}),
    };
  }
  setParent(p: string) { this.parent = p; }
  async started() { return this.startedResult; }
  async stop(reason?: string) {
    if (this.stopFails) throw new Error("kill failed");
    if (this.state === "exited") return;
    this.exitReason = reason ?? "stopped";
    this.push({ type: "exited", data: { reason: this.exitReason } });
    await super.stop();
  }
}
const uuid = (n: number) => `${n.toString(16).padStart(8, "0")}-0000-4000-8000-000000000000`;
const agent = (id: string, role = "lead") => `agent:vm/${id.slice(0, 8)}/${role}`;
const settle = (ms = 40) => new Promise((r) => setTimeout(r, ms));

type Started = { kind: "node" | "pty"; opts: Record<string, unknown>; caller: Caller; driver: Dr };
type Opts = {
  past?: SessionSummary[];
  agents?: AgentInfo[];
  account?: Deps["account"];
  notify?: boolean;
  noPty?: boolean;
  noFork?: boolean;
  onStart?: (d: Dr, kind: "node" | "pty") => void;
  counts?: Record<string, number>;
  terminalAccount?: Deps["terminalAccount"];
};
function harness(o: Opts = {}) {
  const store = new SessionStore();
  let n = 0xb0000000;
  const started: Started[] = [];
  const logs: string[] = [];
  const forks: Array<{ from: string; id: string; dir?: string }> = [];
  const deleted: string[] = [];
  const past = o.past ?? [];
  const registry = new StaticRegistry([{ name: "vm", url: "https://ccn-vm.example", status: "healthy", self: true }]);
  const make = (kind: "node" | "pty") => async (opts: Record<string, any>, caller: Caller) => {
    const d = new Dr(opts.resume && !opts.fork ? opts.resume : uuid(n++), { kind, parent: caller.id, cwd: opts.cwd });
    d.permissionMode = opts.permissionMode;
    d.model = opts.model;
    d.title = opts.name;
    if (kind === "node" && !opts.prompt && (opts.defer || opts.sessionId)) d.awaiting = true;
    started.push({ kind, opts, caller, driver: d });
    o.onStart?.(d, kind);
    return d;
  };
  const deps: Deps = {
    nodeName: "vm",
    roots: [DIR],
    lobby: LOBBY,
    store,
    identity: new HeaderIdentity(),
    history: {
      list: async () => past,
      messages: async () => ({ messages: [] }),
      count: async (id: string) => o.counts?.[id] ?? 0,
      get: async (id: string) => past.find((s) => s.id === id),
    } as unknown as Deps["history"],
    startNode: make("node") as unknown as Deps["startNode"],
    startPty: o.noPty ? undefined : (make("pty") as unknown as Deps["startPty"]),
    agents: async () => o.agents ?? [],
    terminalFor: (a) => { const d = new FakeDriver({ id: a.sessionId!, capabilities: termCaps, kind: "terminal" }); d.cwd = a.cwd; d.state = "idle"; return d; },
    host: async () => ({ claudeVersion: "x", load: [0] }),
    registry,
    relay: new Relay({ registry, nodeName: "vm" }),
    appRoot: join(import.meta.dir, "..", ".."),
    account: o.account,
    terminalAccount: o.terminalAccount,
    notifyParent: o.notify ? { delayMs: 5, minGapMs: 0, retryMs: 5 } : false,
    succeedReadyMs: 50,
    log: (m) => logs.push(m),
    teleport: o.noFork ? undefined : ({
      fns: {
        forkSession: async (id: string, opt?: { dir?: string }) => { const sid = uuid(n++); forks.push({ from: id, id: sid, dir: opt?.dir }); return { sessionId: sid }; },
        deleteSession: async (id: string) => { deleted.push(id); },
      },
    } as unknown as Deps["teleport"]),
  };
  const app = createApp(deps);
  const post = async (body: Record<string, unknown>, from?: string) => {
    const r = await app.fetch(new Request("http://127.0.0.1/api/sessions", { method: "POST", headers: { "content-type": "application/json", ...(from ? { "x-ccn-from": from } : {}) }, body: JSON.stringify(body) }));
    return { status: r.status, body: (await r.json()) as Record<string, any> };
  };
  const list = async (q = "") => (await (await app.fetch(new Request(`http://127.0.0.1/api/sessions${q}`))).json()) as SessionSummary[];
  const get = async (id: string) => (await (await app.fetch(new Request(`http://127.0.0.1/api/sessions/${id}`))).json()) as Record<string, any>;
  const drv = (id: string) => store.get(id) as Dr;
  return { app, store, started, forks, deleted, logs, post, list, get, drv };
}
type H = ReturnType<typeof harness>;
// 人が立てた親（深さ0）と、その子2つ（深さ1）
async function family(h: H, kind: "pty" | "node" = "pty") {
  const parent = (await h.post({ cwd: WORK, prompt: "p", permissionMode: "bypassPermissions", model: "haiku", ...(kind === "pty" ? { terminal: true, name: "親" } : {}) })).body.id as string;
  const a = (await h.post({ cwd: WORK, prompt: "a" }, agent(parent, "meta"))).body.id as string;
  const b = (await h.post({ cwd: OTHER, prompt: "b", terminal: true }, agent(parent, "lead"))).body.id as string;
  return { parent, a, b };
}

test("succeed は resume と fork: true が要る。真偽値でなければ 400、前任が無ければ 404、会話がまだ無ければ 409", async () => {
  const h = harness();
  expect((await h.post({ succeed: true })).status).toBe(400);
  expect((await h.post({ succeed: true, resume: uuid(1) })).status).toBe(400);
  expect((await h.post({ succeed: true, fork: true })).status).toBe(400);
  expect((await h.post({ succeed: "yes", resume: uuid(1), fork: true })).status).toBe(400);
  const none = await h.post({ succeed: true, resume: uuid(1), fork: true });
  expect(none.status).toBe(404);
  // プロンプト無しで立てて1通も届いていないセッション
  const idle = (await h.post({ cwd: WORK })).body.id as string;
  const empty = await h.post({ succeed: true, resume: idle, fork: true });
  expect(empty.status).toBe(409);
  expect(empty.body.code).toBe("empty");
  expect(h.started.length).toBe(1);
});

test("後継は呼び手が名乗らなくても前任の parent と depth を継ぎ、前任の子は後継の子になり、前任は止まる", async () => {
  const h = harness();
  const top = (await h.post({ cwd: WORK, prompt: "top" })).body.id as string;
  // 前任は top の子（深さ1）。その下に孫が2つ（深さ2）
  const pred = (await h.post({ cwd: WORK, prompt: "p", terminal: true, name: "前任", permissionMode: "bypassPermissions", model: "haiku" }, agent(top, "meta"))).body.id as string;
  const g1 = (await h.post({ cwd: WORK, prompt: "g1" }, agent(pred, "lead"))).body.id as string;
  const g2 = (await h.post({ cwd: OTHER, prompt: "g2", terminal: true }, agent(pred, "reviewer"))).body.id as string;
  const other = (await h.post({ cwd: WORK, prompt: "o" }, agent(top, "meta"))).body.id as string;

  const r = await h.post({ resume: pred, fork: true, succeed: true });
  expect(r.status).toBe(201);
  const succ = r.body.id as string;
  expect(succ).not.toBe(pred);
  expect(r.body).toMatchObject({ kind: "pty", cwd: WORK, depth: 1, parent: agent(top, "meta"), cursor: 0 });
  expect(r.body.succeeded).toEqual({ from: pred, stopped: true, adopted: [g1, g2] });
  // 省いた項目は前任から継ぐ。種類も前任と同じ pty
  const s = h.started.at(-1)!;
  expect(s.kind).toBe("pty");
  expect(s.opts).toMatchObject({ cwd: WORK, resume: pred, fork: true, permissionMode: "bypassPermissions", model: "haiku", name: "前任" });
  expect(s.opts.prompt).toBeUndefined();

  const all = await h.list();
  const by = (id: string) => all.find((x) => x.id === id)!;
  expect(by(succ)).toMatchObject({ parent: agent(top, "meta"), depth: 1, state: "idle" });
  expect(by(g1)).toMatchObject({ parent: agent(succ, "lead"), depth: 2 });
  expect(by(g2)).toMatchObject({ parent: agent(succ, "reviewer"), depth: 2 });
  expect(by(other).parent).toBe(agent(top, "meta")); // 前任の兄弟は変わらない
  expect(by(pred)).toMatchObject({ state: "exited", exitReason: succeededReason(succ) });
  expect(successorOf(by(pred).exitReason)).toBe(succ);
  // 付け替えはメモリだけなので、起動し直した後の手がかりをログに残す
  expect(h.logs).toEqual([`succeed: ${pred} -> ${succ} (parent ${agent(top, "meta")}, depth 1, adopted ${g1},${g2}, stopped true)`]);
  // 一覧の ?parent= も新しい名前で引ける
  expect((await h.list(`?parent=${encodeURIComponent(agent(succ, "lead"))}`)).map((x) => x.id)).toEqual([g1]);
  expect((await h.list(`?parent=${encodeURIComponent(agent(pred, "lead"))}`)).length).toBe(0);
  // 孫の後継は子を作れないまま（深さの上限は変わらない）
  const deep = await h.post({ cwd: WORK, prompt: "x" }, agent(g1, "lead"));
  expect(deep.status).toBe(409);
});

test("agent が深さ0の親を引き継いでも、後継は深さ0で parent は前任のまま（呼び手の子にしない）", async () => {
  const h = harness();
  const meta = (await h.post({ cwd: WORK, prompt: "meta" })).body.id as string;
  const f = await family(h);
  const r = await h.post({ resume: f.parent, fork: true, succeed: true, prompt: "続けて" }, agent(meta, "meta"));
  expect(r.status).toBe(201);
  expect(r.body).toMatchObject({ depth: 0, parent: "local" });
  expect(r.body.succeeded.adopted).toEqual([f.a, f.b]);
  // 最初の文の from 行は呼び手のまま
  expect(h.started.at(-1)!.opts.prompt).toBe(`from ${agent(meta, "meta")} via vm\n\n続けて`);
  expect(h.started.at(-1)!.caller.id).toBe("local");
});

test("渡した項目は前任より優先する。terminal: false なら node の後継になる", async () => {
  const h = harness();
  const f = await family(h);
  const r = await h.post({ resume: f.parent, fork: true, succeed: true, cwd: OTHER, permissionMode: "default", model: "sonnet", terminal: false });
  expect(r.status).toBe(201);
  expect(r.body).toMatchObject({ kind: "node", cwd: OTHER });
  expect(h.started.at(-1)!.opts).toMatchObject({ cwd: OTHER, permissionMode: "default", model: "sonnet" });
});

test("node の後継は、SDK の forkSession で id を先に決めてから resume する。最初の文が無ければ claude を起動しない", async () => {
  const h = harness({ counts: {} });
  const f = await family(h, "node");
  const r = await h.post({ resume: f.parent, fork: true, succeed: true });
  expect(r.status).toBe(201);
  expect(h.forks).toEqual([{ from: f.parent, id: r.body.id, dir: WORK }]);
  const s = h.started.at(-1)!;
  expect(s.kind).toBe("node");
  expect(s.opts).toMatchObject({ resume: r.body.id, defer: true, permissionMode: "bypassPermissions", model: "haiku" });
  expect(s.opts.fork).toBeUndefined();
  expect(r.body.succeeded).toEqual({ from: f.parent, stopped: true, adopted: [f.a, f.b] });
  expect(h.deleted).toEqual([]);
});

test("node の後継の cursor は、写した会話の件数（前の会話の返事を今の返事として読まない）", async () => {
  const counts: Record<string, number> = {};
  const h = harness({ counts });
  const f = await family(h, "node");
  // 次に fork で振られる id の件数を先に入れておく
  const next = uuid(0xb0000000 + h.started.length);
  counts[next] = 12;
  const r = await h.post({ resume: f.parent, fork: true, succeed: true, prompt: "続けて" });
  expect(r.body.id).toBe(next);
  expect(r.body.cursor).toBe(12);
  expect(h.started.at(-1)!.opts.defer).toBe(false);
});

test("SDK の forkSession が無いノードでは、node の後継を 400 で断る（terminal: true を案内する）", async () => {
  const h = harness({ noFork: true });
  const f = await family(h, "node");
  const r = await h.post({ resume: f.parent, fork: true, succeed: true });
  expect(r.status).toBe(400);
  expect(r.body.hint).toContain("terminal");
  expect(h.drv(f.parent).summary().state).toBe("idle");
});

test("前任が履歴だけで呼び手が名乗らなくても、後継の parent は最初の文の from 行の呼び手になる（local にならない）", async () => {
  const pred = uuid(0x11110000);
  const top = uuid(0x22220000);
  const past: SessionSummary[] = [{ id: pred, kind: "node", capabilities: { ...caps, send: false, stop: false }, cwd: WORK, state: "exited", startedAt: 1, lastActivityAt: 1, parent: agent(top, "meta") }];
  const h = harness({ past });
  // 前任の子は生きている（前任のプロセスだけが落ちた後）
  const child = (await h.post({ cwd: WORK, prompt: "c" }, agent(pred, "lead"))).body.id as string;
  const r = await h.post({ resume: pred, fork: true, succeed: true, terminal: true });
  expect(r.status).toBe(201);
  expect(r.body.parent).toBe(agent(top, "meta"));
  expect(r.body.depth).toBe(1);
  expect(r.body.succeeded).toEqual({ from: pred, stopped: true, adopted: [child] });
  expect((await h.get(child)).parent).toBe(agent(r.body.id, "lead"));
  // 履歴だけの前任は種類が分からないので、terminal を省くと node になる
  const h2 = harness({ past });
  const r2 = await h2.post({ resume: pred, fork: true, succeed: true });
  expect(r2.body.kind).toBe("node");
});

test("端末の前任は ccn が止められない。子は付け替え、stopped: false と理由を返す。後継は pty になる", async () => {
  const pred = uuid(0x33330000);
  const term: AgentInfo = { pid: 77, cwd: WORK, kind: "interactive", startedAt: 2, sessionId: pred, status: "idle", name: "手で開いた親" };
  const h = harness({ agents: [term] });
  const child = (await h.post({ cwd: WORK, prompt: "c" }, agent(pred, "meta"))).body.id as string;
  const r = await h.post({ resume: pred, fork: true, succeed: true }, "someone@example.com");
  expect(r.status).toBe(201);
  expect(r.body.kind).toBe("pty");
  // 端末のセッションは parent を持たないので、呼び手が後継の parent になる
  expect(r.body.parent).toBe("someone@example.com");
  expect(r.body.depth).toBe(0);
  expect(r.body.succeeded.stopped).toBe(false);
  expect(r.body.succeeded.note).toContain("terminal session");
  expect(r.body.succeeded.adopted).toEqual([child]);
});

test("前任の停止が落ちたら stopped: false と理由を返す。子の付け替えは済んでいる", async () => {
  const h = harness();
  const f = await family(h);
  h.drv(f.parent).stopFails = true;
  const r = await h.post({ resume: f.parent, fork: true, succeed: true });
  expect(r.status).toBe(201);
  expect(r.body.succeeded.stopped).toBe(false);
  expect(r.body.succeeded.note).toContain("kill failed");
  expect(r.body.succeeded.adopted).toEqual([f.a, f.b]);
});

test("もとから終わっていた前任（台帳に残っているもの）も引き継げ、stopped は true", async () => {
  const h = harness();
  const f = await family(h);
  await h.drv(f.parent).stop("exit 1");
  await settle(10);
  const r = await h.post({ resume: f.parent, fork: true, succeed: true });
  expect(r.status).toBe(201);
  expect(r.body.succeeded).toEqual({ from: f.parent, stopped: true, adopted: [f.a, f.b] });
});

test("受け口を挟んだ子も後継に付く。受け口が台帳にあれば受け口を付け替え、履歴だけなら子を後継の直接の子にする", async () => {
  // 受け口のセッションが台帳にある
  const h = harness();
  const pred = (await h.post({ cwd: WORK, prompt: "p" })).body.id as string;
  const lobby = (await h.post({ prompt: "探して" }, agent(pred, "meta"))).body.id as string;
  const viaLobby = (await h.post({ cwd: WORK, prompt: "c" }, agent(lobby, "lobby"))).body.id as string;
  const r = await h.post({ resume: pred, fork: true, succeed: true, terminal: true });
  expect(r.body.succeeded.adopted).toEqual([lobby]);
  expect((await h.get(lobby)).parent).toBe(agent(r.body.id, "meta"));
  expect((await h.get(viaLobby)).parent).toBe(agent(lobby, "lobby"));

  // 受け口のセッションは掃かれて履歴だけ
  const pred2 = uuid(0x44440000);
  const lobby2 = uuid(0x55550000);
  const unrelatedLobby = uuid(0x66660000);
  const past: SessionSummary[] = [
    { id: lobby2, kind: "node", capabilities: termCaps, cwd: LOBBY, state: "exited", startedAt: 1, lastActivityAt: 1, parent: agent(pred2, "meta") },
    { id: unrelatedLobby, kind: "node", capabilities: termCaps, cwd: LOBBY, state: "exited", startedAt: 1, lastActivityAt: 1, parent: agent(uuid(0x77770000), "meta") },
    { id: pred2, kind: "node", capabilities: termCaps, cwd: WORK, state: "exited", startedAt: 1, lastActivityAt: 1, parent: "local" },
  ];
  const h2 = harness({ past });
  const c2 = (await h2.post({ cwd: WORK, prompt: "c" }, agent(lobby2, "lobby"))).body.id as string;
  const c3 = (await h2.post({ cwd: WORK, prompt: "c" }, agent(unrelatedLobby, "lobby"))).body.id as string;
  const r2 = await h2.post({ resume: pred2, fork: true, succeed: true, terminal: true });
  expect(r2.status).toBe(201);
  expect(r2.body.succeeded.adopted).toEqual([c2]);
  expect((await h2.get(c2)).parent).toBe(agent(r2.body.id, "meta"));
  expect((await h2.get(c3)).parent).toBe(agent(unrelatedLobby, "lobby"));
});

test("前任の子の知らせは後継に届き、前任の親には「引き継がれた」と後継の id が届く。前任の resume は勧めない", async () => {
  const h = harness({ notify: true });
  const top = (await h.post({ cwd: WORK, prompt: "top" })).body.id as string;
  const pred = (await h.post({ cwd: WORK, prompt: "p", terminal: true }, agent(top, "meta"))).body.id as string;
  const child = (await h.post({ cwd: WORK, prompt: "c" }, agent(pred, "lead"))).body.id as string;
  const r = await h.post({ resume: pred, fork: true, succeed: true });
  const succ = r.body.id as string;
  await settle();
  // 前任の親（top）への知らせ
  const toTop = h.drv(top).sent;
  expect(toTop.length).toBe(1);
  expect(toTop[0]).toContain(`from ccn:vm/${pred.slice(0, 8)} via vm`);
  expect(toTop[0]).toContain(`${succ.slice(0, 8)} に引き継がれて止まった`);
  expect(toTop[0]).toContain(`session=${succ}`);
  expect(toTop[0]).not.toContain(`resume=${pred}`);
  // 子のターンの終わりは後継に届く。止まった前任には届かない
  const c = h.drv(child);
  c.push({ type: "result", data: { subtype: "success" } });
  await settle();
  expect(h.drv(succ).sent.length).toBe(1);
  expect(h.drv(succ).sent[0]).toContain(`from ccn:vm/${child.slice(0, 8)} via vm`);
  expect(h.drv(pred).sent.length).toBe(0);
  // 後継のターンの終わりは、前任の親に届く
  h.drv(succ).push({ type: "result", data: { subtype: "success" } });
  await settle();
  expect(h.drv(top).sent.length).toBe(2);
  expect(h.drv(top).sent[1]).toContain(`session=${succ}`);
});

test("引き継がれた前任への send は 409 で後継の id を返す。引き継ぎと関係ない終了は今までどおり resume を案内する", async () => {
  const h = harness();
  const f = await family(h);
  const r = await h.post({ resume: f.parent, fork: true, succeed: true });
  const send = async (id: string) => {
    const res = await h.app.fetch(new Request(`http://127.0.0.1/api/sessions/${id}/messages`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: "hi" }) }));
    return { status: res.status, body: (await res.json()) as Record<string, any> };
  };
  const toPred = await send(f.parent);
  expect(toPred.status).toBe(409);
  expect(toPred.body.successor).toBe(r.body.id);
  expect(toPred.body.hint).toContain(r.body.id);
  expect(toPred.body.hint).not.toBe("resume");
  await h.drv(f.a).stop();
  const toA = await send(f.a);
  expect(toA.body).toEqual({ error: "session exited", hint: "resume" });
});

test("枠の残るアカウントが無ければ、後継を立てずに 409 で断る。取り直して選び、前任と子は変えない", async () => {
  const asked: Array<{ fresh?: boolean } | undefined> = [];
  let none = false;
  const h = harness({ account: async (o) => { asked.push(o); return none ? { none: { nextAvailable: { account: "b", at: 1794921000000 } } } : { name: "a" }; } });
  const f = await family(h);
  const before = h.started.length;
  asked.length = 0;
  none = true;
  const r = await h.post({ resume: f.parent, fork: true, succeed: true });
  expect(r.status).toBe(409);
  expect(r.body).toMatchObject({ code: "no_account", nextAvailable: { account: "b", at: 1794921000000 } });
  expect(asked).toEqual([{ fresh: true }]); // 使い回さずに取り直す
  expect(h.started.length).toBe(before);
  expect(h.drv(f.parent).summary().state).toBe("idle");
  expect(h.drv(f.a).summary().parent).toBe(agent(f.parent, "meta"));
  // 枠が戻れば引き継げる（断った要求は「引き継ぎ済み」に数えない）
  none = false;
  expect((await h.post({ resume: f.parent, fork: true, succeed: true })).status).toBe(201);
});

test("後継が起動の印を返さなければ 502 で、後継を片付け、前任と子は変えない", async () => {
  let fail = false;
  const h = harness({ notify: true, onStart: (d) => { if (fail) d.startedResult = false; } });
  const top = (await h.post({ cwd: WORK, prompt: "top" })).body.id as string;
  const pred = (await h.post({ cwd: WORK, prompt: "p", terminal: true }, agent(top, "meta"))).body.id as string;
  const child = (await h.post({ cwd: WORK, prompt: "c" }, agent(pred, "lead"))).body.id as string;
  fail = true;
  const r = await h.post({ resume: pred, fork: true, succeed: true });
  expect(r.status).toBe(502);
  expect(r.body.code).toBe("successor_failed");
  const failedId = h.started.at(-1)!.driver.id;
  expect(h.store.get(failedId)).toBeUndefined();
  expect(h.started.at(-1)!.driver.summary().state).toBe("exited");
  expect(h.drv(pred).summary().state).toBe("idle");
  expect(h.drv(child).summary().parent).toBe(agent(pred, "lead"));
  await settle();
  expect(h.drv(top).sent).toEqual([]); // 立たなかった後継の終わりを親に知らせない
  // やり直せる
  fail = false;
  const again = await h.post({ resume: pred, fork: true, succeed: true });
  expect(again.status).toBe(201);
  expect(again.body.succeeded.adopted).toEqual([child]);
});

test("起動した直後に終わった後継も 502。node の後継なら、写した会話を消す", async () => {
  let fail = true;
  const h = harness({ onStart: (d, kind) => { if (fail && kind === "node" && d.awaiting) { d.exitReason = "exit 1"; d.state = "exited"; } } });
  fail = false;
  const f = await family(h, "node");
  fail = true;
  const r = await h.post({ resume: f.parent, fork: true, succeed: true });
  expect(r.status).toBe(502);
  expect(r.body.reason).toBe("exit 1");
  expect(h.deleted).toEqual([h.forks[0]!.id]);
  expect(h.drv(f.parent).summary().state).toBe("idle");
});

test("同じ前任の引き継ぎは1回だけ。済んだ後は 409 で後継の id を返し、途中の2つ目も 409 で断る", async () => {
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  let slow = false;
  const h = harness({ account: async () => { if (slow) await gate; return { name: "a" }; } });
  const f = await family(h);
  slow = true;
  const first = h.post({ resume: f.parent, fork: true, succeed: true });
  await settle(10);
  const second = await h.post({ resume: f.parent, fork: true, succeed: true });
  expect(second.status).toBe(409);
  expect(second.body.code).toBe("succeeding");
  release();
  const r = await first;
  expect(r.status).toBe(201);
  const third = await h.post({ resume: f.parent, fork: true, succeed: true });
  expect(third.status).toBe(409);
  expect(third.body).toMatchObject({ code: "already_succeeded", successor: r.body.id });
  // 後継をさらに引き継ぐのは別の引き継ぎ。親と子がもう一度移る
  const next = await h.post({ resume: r.body.id, fork: true, succeed: true });
  expect(next.status).toBe(201);
  expect(next.body.parent).toBe("local");
  expect(next.body.succeeded.adopted).toEqual([f.a, f.b]);
  expect((await h.get(f.a)).parent).toBe(agent(next.body.id, "meta"));
});

test("孫（深さ2）の呼び手は、引き継ぎも作れない（深さの上限は呼び手で見る）", async () => {
  const h = harness();
  const top = (await h.post({ cwd: WORK, prompt: "top" })).body.id as string;
  const child = (await h.post({ cwd: WORK, prompt: "c" }, agent(top))).body.id as string;
  const grand = (await h.post({ cwd: WORK, prompt: "g" }, agent(child))).body.id as string;
  const r = await h.post({ resume: top, fork: true, succeed: true }, agent(grand));
  expect(r.status).toBe(409);
  expect(r.body.limit).toBe(2);
  expect(h.drv(top).summary().state).toBe("idle");
});

test("作成の応答は parent と、選んだアカウントを返す。枠の残るアカウントが無ければ accountUnavailable で伝える", async () => {
  let none = false;
  const h = harness({
    account: async () => (none ? { none: { nextAvailable: null } } : { name: "a" }),
    onStart: (d) => { if (!none) { d.account = "a"; d.accountEmail = "a@example.com"; } },
  });
  const r = await h.post({ cwd: WORK, prompt: "x", terminal: true }, agent(uuid(9), "meta"));
  expect(r.body).toMatchObject({ parent: agent(uuid(9), "meta"), account: "a", accountEmail: "a@example.com" });
  expect("accountUnavailable" in r.body).toBe(false);
  expect((await h.get(r.body.id)).account).toBe("a");
  expect((await h.list()).find((s) => s.id === r.body.id)).toMatchObject({ account: "a", accountEmail: "a@example.com" });
  none = true;
  const r2 = await h.post({ cwd: WORK, prompt: "x" });
  expect(r2.status).toBe(201); // ふつうの作成は、今までどおりノードの設定で起動する
  expect(r2.body.accountUnavailable).toEqual({ nextAvailable: null });
  expect("account" in r2.body).toBe(false);
  // 1通目を待つ node の子は、まだアカウントを選んでいないので何も載らない（cam usage も呼ばない）
  const r3 = await h.post({ cwd: WORK });
  expect("accountUnavailable" in r3.body).toBe(false);
});

test("端末のセッションは、プロセスの環境から読めたときだけ一覧と詳細にアカウントが載る", async () => {
  const a: AgentInfo = { pid: 77, cwd: WORK, kind: "interactive", startedAt: 2, sessionId: uuid(0x88880000), status: "idle" };
  const b: AgentInfo = { pid: 78, cwd: WORK, kind: "interactive", startedAt: 3, sessionId: uuid(0x99990000), status: "idle" };
  const h = harness({ agents: [a, b], terminalAccount: async (x) => (x.pid === 77 ? { account: "coo", accountEmail: "coo@example.com" } : undefined) });
  const all = await h.list();
  expect(all.find((s) => s.id === a.sessionId)).toMatchObject({ kind: "terminal", account: "coo", accountEmail: "coo@example.com" });
  expect("account" in all.find((s) => s.id === b.sessionId)!).toBe(false);
  expect((await h.get(a.sessionId!)).account).toBe("coo");
  expect("account" in (await h.get(b.sessionId!))).toBe(false);
});

test("succeed を付けない fork と resume は今までどおり（呼び手が parent、前任は止めない）", async () => {
  const h = harness();
  const f = await family(h);
  const r = await h.post({ cwd: WORK, resume: f.parent, fork: true, terminal: true, succeed: false }, agent(uuid(7), "meta"));
  expect(r.status).toBe(201);
  expect(r.body.parent).toBe(agent(uuid(7), "meta"));
  expect("succeeded" in r.body).toBe(false);
  expect(h.drv(f.parent).summary().state).toBe("idle");
  expect(h.drv(f.a).summary().parent).toBe(agent(f.parent, "meta"));
});
