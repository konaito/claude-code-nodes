// セッションの監視と管理の処理。台帳（生きているもの）、agents（端末）、履歴（過去）を合成し、能力で振る舞いを決める
import { resolve, sep } from "node:path";
import { realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import type { Driver } from "../engine/driver";
import type { AgentInfo } from "../engine/agents";
import type { StartOptions } from "../engine/node-driver";
import type { PtyDriver, PtyStartOptions } from "../engine/pty-driver";
import type { History } from "../engine/history";
import type { SessionStore } from "../sessions/store";
import type { PermissionAnswer, SessionSummary } from "../sessions/types";
import type { Identity, Caller } from "../identity/identity";
import type { Registry } from "../registry/registry";
import type { Relay } from "../relay/relay";
import { withFromLine } from "../identity/from-line";
import type { McpOptions } from "../mcp/server";
import { HttpError } from "./errors";
import { lobbySettingsFor, secretBases } from "../lobby/lobby";
import { PlacesScanner, selectPlaces, usageOf } from "../lobby/places";
import { sse } from "./sse";

export type HostInfo = { claudeVersion: string; account?: string; rateLimit?: unknown; load: number[] };
export type Deps = {
  nodeName: string;
  roots: string[];
  lobby: string; // 受け口。cwd を省いて立てたセッションの置き場（names.ts の lobbyDirOf か設定の lobby）
  store: SessionStore;
  identity: Identity;
  history: History;
  startNode: (opts: StartOptions, caller: Caller) => Promise<Driver>;
  startPty?: (opts: PtyStartOptions, caller: Caller) => Promise<PtyDriver>; // terminal: true の作成。無いノードは 400 で断る
  agents: () => Promise<AgentInfo[]>;
  terminalFor: (a: AgentInfo) => Driver;
  host: () => Promise<HostInfo>;
  registry: Registry;
  relay: Relay;
  appRoot: string; // 実行物の置き場。/install と /skill.md が配る
  home?: string;       // 秘密の置き場の基点（places が辿らない場所）。無ければ os.homedir()
  configFile?: string; // 読んでいる設定ファイル。places はこのファイルと隣の tunnel.token も読まない
  mcp?: McpOptions; // MCP の待ちの時計と間隔（試験で差し替える）。無ければ実時間
  places?: PlacesScanner; // places の走査（試験で止まる fs に差し替える）。無ければ本物の fs
};

const underRoot = (cwd: string, roots: string[]) => roots.some((root) => cwd === root || cwd.startsWith(root + sep));

// terminal: true のときの name、cols、rows。端末の大きさは常識的な範囲だけ受ける
function ptyFields(b: { name?: unknown; cols?: unknown; rows?: unknown }): { name?: string; cols?: number; rows?: number } {
  const dim = (v: unknown, k: string) => {
    if (v === undefined) return undefined;
    if (typeof v !== "number" || !Number.isInteger(v) || v < 10 || v > 1000) throw new HttpError(400, { error: `${k} must be an integer from 10 to 1000` });
    return v;
  };
  if (b.name !== undefined && (typeof b.name !== "string" || !b.name.trim() || b.name.length > 200)) throw new HttpError(400, { error: "name must be a non-empty string up to 200 chars" });
  return { name: b.name as string | undefined, cols: dim(b.cols, "cols"), rows: dim(b.rows, "rows") };
}

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
    // 受け口は symlink を解いた実体で返す（セッションの cwd と同じ形にして、画面が受け口のセッションを見分けられるように）
    const lobby = await realpath(resolve(this.d.lobby)).catch(() => this.d.lobby);
    return { name: this.d.nodeName, roots: this.d.roots, lobby, ...h, rateLimit: h.rateLimit ?? this.d.store.rateLimit() };
  }
  peers() { return this.d.registry.peers(); }
  private scanner?: PlacesScanner;
  // 行き先の候補。roots の直下と Documents の直下のディレクトリごとに、README の先頭、remote、最近使われたかを返す（src/lobby/places.ts）。
  // 走査は同時の呼び出しで1つを共有し、3秒で打ち切る。読めなかった場所があれば partial、unreadable、note で伝える
  async places(q: string | null, limit: number | null) {
    const scanner = (this.scanner ??= this.d.places ?? new PlacesScanner());
    const home = this.d.home ?? homedir();
    const scan = scanner.scan({ roots: this.d.roots, bases: secretBases(this.d.roots, { home }), configFile: this.d.configFile, lobby: this.d.lobby, home });
    const [res, sessions, host] = await Promise.all([scan, this.list(null), realpath(resolve(this.d.lobby)).catch(() => this.d.lobby)]);
    // 履歴の cwd は symlink を解いていないことがあるので、解いてから比べる。roots の外と保護フォルダの中は解かない
    const cwds = await scanner.resolveCwds(sessions.map((s) => s.cwd).filter(Boolean), { roots: [...this.d.roots, ...(await this.roots())], home });
    const used = usageOf(res.places, sessions.filter((s) => s.cwd).map((s) => ({ cwd: cwds.get(s.cwd) ?? s.cwd, lastActivityAt: s.lastActivityAt })));
    const r = selectPlaces(res.places, used, { q: q ?? undefined, limit: limit ?? undefined });
    const partial = res.partial ? { partial: true, unreadable: res.unreadable, note: `some folders did not answer in time and were skipped${res.unreadable.length ? `: ${res.unreadable.slice(0, 10).join(", ")}` : ""}` } : { partial: false };
    return { name: this.d.nodeName, lobby: host, roots: this.d.roots, ...r, ...partial };
  }
  async list(parent: string | null): Promise<SessionSummary[]> {
    const live = this.d.store.list();
    const seen = new Set(live.map((s) => s.id));
    const terms = (await this.agents()).filter((a) => a.sessionId && !seen.has(a.sessionId)).map((a) => this.d.terminalFor(a).summary());
    for (const t of terms) seen.add(t.id);
    const past = (await this.past()).filter((h) => !seen.has(h.id));
    const all = [...live, ...terms, ...past];
    return parent ? all.filter((s) => s.parent === parent) : all;
  }
  // cwd を省くと受け口に立てる。prompt も resume も無ければ id だけ先に決め、1通目（send）が来るまで claude を起動しない（state は idle）
  async create(req: Request, caller: Caller) {
    const body = (await req.json().catch(() => ({}))) as Partial<StartOptions> & { cwd?: unknown; terminal?: unknown; name?: unknown; cols?: unknown; rows?: unknown };
    const pty = body.terminal === true ? ptyFields(body) : undefined;
    if (body.cwd !== undefined && (typeof body.cwd !== "string" || !body.cwd)) throw new HttpError(400, { error: "cwd must be a non-empty string or omitted (omit for the lobby)" });
    const asked = typeof body.cwd === "string" ? body.cwd : this.d.lobby;
    // symlink を解いた実体で根と比べる。存在しなければ realpath が失敗する
    const cwd = await realpath(resolve(asked)).catch(() => null);
    if (!cwd) throw new HttpError(400, body.cwd === undefined ? { error: "lobby does not exist", lobby: this.d.lobby, hint: "restart the node or run ccn update" } : { error: "cwd does not exist" });
    if (!underRoot(cwd, await this.roots())) throw new HttpError(400, { error: "cwd is outside roots", roots: this.d.roots });
    const st = await stat(cwd).catch(() => null);
    if (!st?.isDirectory()) throw new HttpError(400, { error: "cwd is not a directory" });
    // 生きている id を fork 無しで resume すると古いプロセスが孤児になるので断る
    if (body.resume && !body.fork) {
      const liveOne = this.d.store.get(body.resume);
      if (liveOne && liveOne.summary().state !== "exited") throw new HttpError(409, { error: "session is still running", hint: "delete first" });
    }
    if (pty) {
      if (!this.d.startPty) throw new HttpError(400, { error: "terminal sessions are not supported on this node" });
      const settings = await lobbySettingsFor(cwd, this.d.lobby);
      const prompt = body.prompt ? withFromLine(caller, this.d.nodeName, body.prompt) : undefined;
      const driver = await this.d.startPty({ cwd, prompt, permissionMode: body.permissionMode, model: body.model, resume: body.resume, fork: body.fork, settings, ...pty }, caller);
      this.d.store.add(driver);
      return { id: driver.id, cwd, state: driver.summary().state, kind: driver.kind };
    }
    // sessionId は呼び手から受けない（既にある jsonl と重ねないため）。新規でプロンプトが無いときだけノードが決める
    const sessionId = !body.prompt && !body.resume ? crypto.randomUUID() : undefined;
    // settings は呼び手から受けない。受け口（resume を含む）のときだけ、ノードが書いた受け口の許可を渡す
    const settings = await lobbySettingsFor(cwd, this.d.lobby);
    const opts: StartOptions = { ...body, cwd, sessionId, settings, prompt: body.prompt ? withFromLine(caller, this.d.nodeName, body.prompt) : undefined } as StartOptions;
    const driver = await this.d.startNode(opts, caller);
    this.d.store.add(driver);
    return { id: driver.id, cwd, state: driver.summary().state, kind: driver.kind };
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
