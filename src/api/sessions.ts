// セッションの監視と管理の処理。台帳（生きているもの）、agents（端末）、履歴（過去）を合成し、能力で振る舞いを決める
import { resolve, sep } from "node:path";
import { realpath, stat } from "node:fs/promises";
import type { Driver } from "../engine/driver";
import type { AgentInfo } from "../engine/agents";
import type { StartOptions } from "../engine/node-driver";
import type { History } from "../engine/history";
import type { SessionStore } from "../sessions/store";
import type { PermissionAnswer, SessionSummary } from "../sessions/types";
import type { Identity, Caller } from "../identity/identity";
import type { Registry } from "../registry/registry";
import type { Relay } from "../relay/relay";
import { withFromLine } from "../identity/from-line";
import { HttpError } from "./errors";
import { sse } from "./sse";

export type HostInfo = { claudeVersion: string; account?: string; rateLimit?: unknown; load: number[] };
export type Deps = {
  nodeName: string;
  roots: string[];
  store: SessionStore;
  identity: Identity;
  history: History;
  startNode: (opts: StartOptions, caller: Caller) => Promise<Driver>;
  agents: () => Promise<AgentInfo[]>;
  terminalFor: (a: AgentInfo) => Driver;
  host: () => Promise<HostInfo>;
  registry: Registry;
  relay: Relay;
  appRoot: string; // 実行物の置き場。/install が配る
};

const underRoot = (cwd: string, roots: string[]) => roots.some((root) => cwd === root || cwd.startsWith(root + sep));

const CACHE_MS = 2000; // 一覧のたびに claude を起動しないための短いメモリキャッシュ

export class Sessions {
  private cache = new Map<string, { at: number; value: Promise<unknown> }>();
  private realRoots?: Promise<string[]>;
  constructor(private d: Deps) {}

  // 根も symlink（macOS の /var など）を解いて比べる。解けない根はそのまま
  private roots(): Promise<string[]> {
    this.realRoots ??= Promise.all(this.d.roots.map((r) => realpath(resolve(r)).catch(() => resolve(r))));
    return this.realRoots;
  }

  private cached<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const hit = this.cache.get(key);
    if (hit && Date.now() - hit.at < CACHE_MS) return hit.value as Promise<T>;
    const value = fn();
    this.cache.set(key, { at: Date.now(), value });
    return value;
  }
  private agents() { return this.cached("agents", () => this.d.agents()); }
  private past() { return this.cached("history", () => this.d.history.list()); }

  async host() {
    const h = await this.d.host();
    return { name: this.d.nodeName, roots: this.d.roots, ...h, rateLimit: h.rateLimit ?? this.d.store.rateLimit() };
  }
  peers() { return this.d.registry.peers(); }
  async list(parent: string | null): Promise<SessionSummary[]> {
    const live = this.d.store.list();
    const seen = new Set(live.map((s) => s.id));
    const terms = (await this.agents()).filter((a) => a.sessionId && !seen.has(a.sessionId)).map((a) => this.d.terminalFor(a).summary());
    for (const t of terms) seen.add(t.id);
    const past = (await this.past()).filter((h) => !seen.has(h.id));
    const all = [...live, ...terms, ...past];
    return parent ? all.filter((s) => s.parent === parent) : all;
  }
  async create(req: Request, caller: Caller) {
    const body = (await req.json().catch(() => ({}))) as Partial<StartOptions> & { cwd?: unknown };
    if (typeof body.cwd !== "string" || !body.cwd) throw new HttpError(400, { error: "cwd is required" });
    // symlink を解いた実体で根と比べる。存在しなければ realpath が失敗する
    const cwd = await realpath(resolve(body.cwd)).catch(() => null);
    if (!cwd) throw new HttpError(400, { error: "cwd does not exist" });
    if (!underRoot(cwd, await this.roots())) throw new HttpError(400, { error: "cwd is outside roots", roots: this.d.roots });
    const st = await stat(cwd).catch(() => null);
    if (!st?.isDirectory()) throw new HttpError(400, { error: "cwd is not a directory" });
    if (!body.prompt && !body.resume) throw new HttpError(400, { error: "prompt or resume is required" });
    // 生きている id を fork 無しで resume すると古いプロセスが孤児になるので断る
    if (body.resume && !body.fork) {
      const liveOne = this.d.store.get(body.resume);
      if (liveOne && liveOne.summary().state !== "exited") throw new HttpError(409, { error: "session is still running", hint: "delete first" });
    }
    const opts: StartOptions = { ...body, cwd, prompt: body.prompt ? withFromLine(caller, this.d.nodeName, body.prompt) : undefined } as StartOptions;
    const driver = await this.d.startNode(opts, caller);
    this.d.store.add(driver);
    return { id: driver.id };
  }
  // cursor は送る前の末尾。CLI の send が控え、read の after にする
  async detail(id: string) {
    const driver = await this.find(id);
    if (driver) return { ...driver.summary(), pending: driver.pending(), cursor: await this.cursor(id) };
    const past = await this.d.history.get(id);
    if (past) return { ...past, pending: [], cursor: await this.cursor(id) };
    throw new HttpError(404, { error: "unknown session" });
  }
  // messages?after= と同じ数え方にする。生きているものは台帳の最後の seq、それ以外（端末、終わったもの、過去）は履歴の件数
  private async cursor(id: string): Promise<number | undefined> {
    const live = this.d.store.get(id);
    if (live && live.summary().state !== "exited") return this.d.store.lastSeq(id) ?? 0;
    // cursor は無くても詳細は返す（古い CLI は messages をたどって数える）
    return Promise.resolve().then(() => this.d.history.count(id)).catch(() => undefined);
  }
  async messages(id: string, after: number) {
    const liveOne = this.d.store.get(id);
    if (liveOne && liveOne.summary().state !== "exited") {
      const events = this.d.store.eventsSince(id, after);
      return { messages: events, next: events.length ? events[events.length - 1]!.seq : undefined };
    }
    return this.d.history.messages(id, after);
  }
  async send(id: string, req: Request, caller: Caller) {
    const driver = await this.must(id);
    if (driver.summary().state === "exited") throw new HttpError(409, { error: "session exited", hint: "resume" });
    const body = (await req.json().catch(() => ({}))) as { text?: unknown };
    if (typeof body.text !== "string" || !body.text.trim()) throw new HttpError(400, { error: "text is required" });
    return driver.send(withFromLine(caller, this.d.nodeName, body.text));
  }
  async answer(id: string, requestId: string, req: Request) {
    const driver = await this.must(id);
    if (!driver.capabilities.permissions) throw new HttpError(409, { error: "capability permissions not available" });
    const body = (await req.json().catch(() => ({}))) as PermissionAnswer;
    if (body.behavior !== "allow" && body.behavior !== "deny") throw new HttpError(400, { error: "behavior must be allow or deny" });
    await driver.answer(requestId, body);
    return { ok: true };
  }
  async interrupt(id: string) {
    const driver = await this.must(id);
    if (!driver.capabilities.interrupt) throw new HttpError(409, { error: "capability interrupt not available" });
    await driver.interrupt();
    return { ok: true };
  }
  async patch(id: string, req: Request) {
    const driver = await this.must(id);
    const body = (await req.json().catch(() => ({}))) as { permissionMode?: unknown };
    if (typeof body.permissionMode === "string") {
      if (!driver.setPermissionMode) throw new HttpError(409, { error: "permission mode cannot be changed on this session" });
      await driver.setPermissionMode(body.permissionMode);
    }
    return driver.summary();
  }
  async remove(id: string) {
    const driver = await this.must(id);
    if (!driver.capabilities.stop) throw new HttpError(409, { error: "capability stop not available" });
    await driver.stop();
    this.d.store.remove(id);
  }
  events(id: string, after: number): Response {
    const live = this.d.store.get(id);
    if (!live) throw new HttpError(404, { error: "no live session" });
    if (!live.capabilities.events) throw new HttpError(409, { error: "capability events not available" });
    const src = this.d.store.subscribe(id, after);
    const trimmed = this.d.store.trimmedTo(id);
    return sse((async function* () {
      // カーソルが上限超えで捨てた範囲より前なら、欠落を先に知らせる
      if (trimmed > after) yield { event: "gap", data: { from: after + 1, to: trimmed } };
      for await (const e of src) yield { id: e.seq, event: e.type, data: e.data };
    })());
  }
  allEvents(): Response {
    const src = this.d.store.subscribeAll();
    return sse((async function* () { for await (const c of src) yield { event: "session", data: c }; })());
  }

  private async find(id: string): Promise<Driver | undefined> {
    const live = this.d.store.get(id);
    if (live) return live;
    const a = (await this.agents()).find((x) => x.sessionId === id);
    return a ? this.d.terminalFor(a) : undefined;
  }
  private async must(id: string): Promise<Driver> {
    const driver = await this.find(id);
    if (!driver) throw new HttpError(404, { error: "unknown session" });
    return driver;
  }
}
