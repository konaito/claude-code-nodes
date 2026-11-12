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
import { DEPTH_HINT, DEPTH_HOPS, DEPTH_REFUSAL, DepthTracer, MAX_DEPTH, type SessionDepth } from "./depth";
import { ListWatch, type ListFilter } from "./list-watch";
import type { State } from "../sessions/types";

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
  listWatch?: { tickMs?: number; debounceMs?: number }; // 一覧の変化を流す間隔（試験で短くする）
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

// 一覧の材料のメモリキャッシュ。古くなっても要求は待たせずに古い値を返し、裏で1回だけ取り直す。
// 取り直しを待たせると、Claude Town の2秒ごとの一覧がほぼ毎回 listSessions と claude の起動を待ち、
// 機械が混んでいると1秒を超えた（2026-11-12 の 23:06、konaito-pro。jsonl 8024 個で listSessions は1回 CPU 約300ms）
const AGENTS_MS = 2000;   // 端末のセッション（claude agents --json）。生きているものなので短く
// 終わったセッション（SDK の listSessions）。重いので長く。15秒だと Claude Town の一覧だけでノードの CPU が約2%になった（#23）。
// 端末のセッションが agents から消えたときは、待たずに取り直す（閉じた端末のセッションを、終わったものとしてすぐ出すため）
const HISTORY_MS = 60_000;
const DEPTH_REMOTE_MS = 5000; // 別のノードに深さを聞く待ち。過ぎたら分からないものとして通す

type CacheEntry = { at: number; value: Promise<unknown>; refreshing: boolean };

export class Sessions {
  private cache = new Map<string, CacheEntry>();
  private realRoots?: Promise<string[]>;
  private depths = new Map<string, number>(); // 作ったときに刻んだ深さ。台帳と同じくメモリだけ
  constructor(private d: Deps) {}

  // 深さをたどる道具。別のノードへは呼び手のまま中継で GET /api/depth を聞く
  private tracer(caller: Caller): DepthTracer {
    return new DepthTracer({
      nodeName: this.d.nodeName,
      stamped: (id) => (this.d.store.get(id) ? this.depths.get(id) : undefined),
      find: async (sid) => (await this.list(null)).filter((s) => s.id.startsWith(sid)),
      firstParent: async (id) => (await this.d.history.get(id))?.parent,
      isLobby: async (cwd) => !!cwd && (cwd === this.d.lobby || cwd === (await realpath(resolve(this.d.lobby)).catch(() => this.d.lobby))),
      remote: (peer, sid, hops) => this.remoteDepth(peer, sid, hops, caller),
    });
  }
  private async remoteDepth(peer: string, sid: string, hops: number, caller: Caller): Promise<SessionDepth | undefined> {
    const q = new URLSearchParams({ session: sid, hops: String(hops) });
    const ask = this.d.relay.forward(peer, "api/depth", new Request(`http://${this.d.nodeName}.invalid/api/depth?${q}`), caller).then(async (r) => {
      if (r.status !== 200) { await r.body?.cancel().catch(() => {}); return undefined; } // 古い版のノードは 404
      const b = (await r.json()) as { found?: boolean; id?: string; depth?: unknown; lobby?: boolean; known?: boolean };
      return b.found && typeof b.depth === "number" ? { id: String(b.id ?? sid), depth: b.depth, lobby: !!b.lobby, known: b.known !== false } : undefined;
    });
    let timer: ReturnType<typeof setTimeout> | undefined;
    const late = new Promise<undefined>((ok) => { timer = setTimeout(() => ok(undefined), DEPTH_REMOTE_MS); });
    return Promise.race([ask.catch(() => undefined), late]).finally(() => clearTimeout(timer));
  }
  // GET /api/depth?session=<sessionId か先頭8文字>。別のノードが、自分の子の呼び手の深さを聞きに来る
  async depth(session: string | null, hops: number | null, caller: Caller) {
    if (!session || !/^[0-9a-f][0-9a-f-]{7,35}$/i.test(session)) throw new HttpError(400, { error: "session must be a sessionId or its first 8+ characters" });
    const d = await this.tracer(caller).session(session.toLowerCase(), Math.min(Math.max(hops ?? DEPTH_HOPS, 0), DEPTH_HOPS));
    return d ? { found: true, ...d } : { found: false };
  }

  // 根も symlink（macOS の /var など）を解いて比べる。解けない根はそのまま
  private roots(): Promise<string[]> {
    this.realRoots ??= Promise.all(this.d.roots.map((r) => realpath(resolve(r)).catch(() => resolve(r))));
    return this.realRoots;
  }

  // 初めての要求だけは取れるまで待つ。失敗したら覚えず、次の要求で取り直す。
  // 古くなったら古い値を返しつつ裏で取り直し、取れたら差し替える。取り直しに失敗したら古い値を使い続け、ttl 後にまた試す
  private cached<T>(key: string, ttl: number, fn: () => Promise<T>): Promise<T> {
    const hit = this.cache.get(key);
    if (!hit) {
      const value = fn();
      this.cache.set(key, { at: Date.now(), value, refreshing: false });
      value.catch(() => { if (this.cache.get(key)?.value === value) this.cache.delete(key); });
      return value;
    }
    if (Date.now() - hit.at >= ttl && !hit.refreshing) {
      hit.refreshing = true;
      const next = fn();
      next.then(
        () => this.cache.set(key, { at: Date.now(), value: next, refreshing: false }),
        () => { hit.refreshing = false; hit.at = Date.now(); },
      );
    }
    return hit.value as Promise<T>;
  }
  private agents() { return this.cached("agents", AGENTS_MS, () => this.d.agents().then((a) => { this.noteAgents(a); return a; })); }
  private agentIds?: Set<string>;
  // 前に見えていた端末のセッションが消えたら、終わったセッションの一覧を次の要求で取り直す
  private noteAgents(a: AgentInfo[]) {
    const ids = new Set(a.map((x) => x.sessionId).filter((x): x is string => !!x));
    if (this.agentIds && [...this.agentIds].some((id) => !ids.has(id))) this.expireHistory();
    this.agentIds = ids;
  }
  // 終わったセッションの一覧を、次の要求で取り直させる
  private expireHistory() {
    const h = this.cache.get("history");
    if (h && !h.refreshing) h.at = 0;
  }
  private past() { return this.cached("history", HISTORY_MS, () => this.d.history.list()); }

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
  // states を渡すと、その状態のものだけを返す。exited を含まなければ、終わったセッションの一覧（listSessions）を読まない
  async list(parent: string | null, states: Set<State> | null = null): Promise<SessionSummary[]> {
    const live = this.d.store.list().map((s) => (this.depths.has(s.id) ? { ...s, depth: this.depths.get(s.id) } : s));
    const seen = new Set(live.map((s) => s.id));
    // PTY の子は `claude agents --json` にも出る。id で除き、端末で /clear して id が変わっても pid で除く
    const ptyPids = new Set(live.filter((s) => s.kind === "pty" && s.state !== "exited" && s.pid).map((s) => s.pid));
    const terms = (await this.agents()).filter((a) => a.sessionId && !seen.has(a.sessionId) && !(a.pid && ptyPids.has(a.pid))).map((a) => this.d.terminalFor(a).summary());
    for (const t of terms) seen.add(t.id);
    const past = !states || states.has("exited") ? (await this.past()).filter((h) => !seen.has(h.id)) : [];
    const all = [...live, ...terms, ...past];
    return all.filter((s) => (!parent || s.parent === parent) && (!states || states.has(s.state)));
  }
  // 一覧の変化を流す SSE。購読がある間だけ、端末のセッションを LIST_TICK_MS ごとに取り直して比べる
  private watch?: ListWatch;
  stream(filter: ListFilter, lastId: string | null): Response {
    this.watch ??= new ListWatch({
      list: (f) => this.list(f.parent, f.states),
      refresh: () => this.refreshAgents(),
      changes: () => this.d.store.subscribeAll(),
      ...this.d.listWatch,
    });
    return sse(this.watch.subscribe(filter, lastId ?? undefined));
  }
  // 端末のセッションを今すぐ取り直す。取れたら一覧の材料のキャッシュも差し替える
  private async refreshAgents() {
    const value = this.d.agents().then((a) => { this.noteAgents(a); return a; });
    await value;
    this.cache.set("agents", { at: Date.now(), value, refreshing: false });
  }
  // cwd を省くと受け口に立てる。prompt も resume も無ければ id だけ先に決め、1通目（send）が来るまで claude を起動しない（state は idle）
  async create(req: Request, caller: Caller) {
    const body = (await req.json().catch(() => ({}))) as Partial<StartOptions> & { cwd?: unknown; terminal?: unknown; name?: unknown; cols?: unknown; rows?: unknown };
    const pty = body.terminal === true ? ptyFields(body) : undefined;
    // 深さの上限。呼び手が孫（深さ2）なら断る。as_session を名乗らない呼び手は人と見分けられないので、暴走止めであって防御ではない
    const tracer = this.tracer(caller);
    const child = await tracer.childOf(caller.id);
    if (child.depth > MAX_DEPTH) {
      throw new HttpError(409, { error: `${DEPTH_REFUSAL}（呼び手 ${caller.id} の深さ: ${child.callerDepth}）`, hint: DEPTH_HINT, depth: child.callerDepth, limit: MAX_DEPTH });
    }
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
      const depth = await this.stampDepth(tracer, child.depth, body.resume);
      const driver = await this.d.startPty({ cwd, prompt, permissionMode: body.permissionMode, model: body.model, resume: body.resume, fork: body.fork, settings, ...pty }, caller);
      this.setDepth(driver.id, depth);
      this.d.store.add(driver);
      return { id: driver.id, cwd, state: driver.summary().state, kind: driver.kind, depth };
    }
    // sessionId は呼び手から受けない（既にある jsonl と重ねないため）。新規でプロンプトが無いときだけノードが決める
    const sessionId = !body.prompt && !body.resume ? crypto.randomUUID() : undefined;
    // settings は呼び手から受けない。受け口（resume を含む）のときだけ、ノードが書いた受け口の許可を渡す
    const settings = await lobbySettingsFor(cwd, this.d.lobby);
    const opts: StartOptions = { ...body, cwd, sessionId, settings, prompt: body.prompt ? withFromLine(caller, this.d.nodeName, body.prompt) : undefined } as StartOptions;
    const depth = await this.stampDepth(tracer, child.depth, body.resume);
    const driver = await this.d.startNode(opts, caller);
    this.setDepth(driver.id, depth);
    this.d.store.add(driver);
    return { id: driver.id, cwd, state: driver.summary().state, kind: driver.kind, depth };
  }
  // resume（転出の取り込みも同じ）では呼び手が新しい親になる。元の親（刻んだ値か最初の文の from 行）の深さと比べて大きいほうを刻む。
  // 人が孫を resume しても深さ0に戻さない
  private async stampDepth(tracer: DepthTracer, depth: number, resume: string | undefined): Promise<number> {
    if (!resume) return depth;
    const past = this.d.store.get(resume)?.summary() ?? (await this.d.history.get(resume).catch(() => undefined));
    const before = await tracer.of({ id: resume, cwd: past?.cwd ?? "", parent: past?.parent }).catch(() => undefined);
    return Math.max(depth, before?.depth ?? 0);
  }
  private setDepth(id: string, depth: number) {
    for (const k of this.depths.keys()) if (!this.d.store.get(k)) this.depths.delete(k);
    this.depths.set(id, depth);
  }
  // cursor は送る前の末尾。CLI の send が控え、read の after にする
  async detail(id: string) {
    const driver = await this.find(id);
    if (driver) return { ...driver.summary(), ...(this.depths.has(driver.id) ? { depth: this.depths.get(driver.id) } : {}), pending: driver.pending(), cursor: await this.cursor(id) };
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
    // 台帳から消したセッションは、終わったセッションの一覧から出す。立ててすぐ止めた子が一覧から消えないように
    this.expireHistory();
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
