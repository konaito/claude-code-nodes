// セッションの監視と管理の処理。台帳（生きているもの）、agents（端末）、履歴（過去）を合成し、能力で振る舞いを決める
import { resolve, sep } from "node:path";
import { realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import type { Driver } from "../engine/driver";
import type { AgentInfo } from "../engine/agents";
import type { StartOptions } from "../engine/node-driver";
import type { PtyDriver, PtyStartOptions } from "../engine/pty-driver";
import { PAGE as HISTORY_PAGE, type History } from "../engine/history";
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

// jsonl（会話の履歴）から返す messages の番号の印。jsonl の位置はノードを起動し直しても変わらないので、決まった値にする
export const HISTORY_EPOCH = "history";
import { PLACES_MAX_LIMIT } from "../lobby/places";
import { decodePack, encodePack, PACK_CONTENT_TYPE, type Pack } from "../teleport/pack";
import { describeRepo } from "../teleport/git";
import { resolveDest, type CheckInput, type PlaceDeps } from "../teleport/place";
import { exportPack, importPack, type TeleportDeps } from "../teleport/teleport";

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
  // claude を起動する前に cwd を信頼済みにする（src/engine/trust.ts）。失敗しても投げない。無ければ何もしない
  trust?: (cwd: string) => Promise<unknown>;
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
  teleport?: TeleportDeps; // セッションを別のノードへ移す（SDK の関数、git、Claude の設定ディレクトリ）。無ければ teleport の道は 501
};

// teleport の取り込みは clone を含むので、中継の最初の応答を長く待つ。Cloudflare は応答の無いまま 100 秒前後で切るので、その手前
const TELEPORT_PEER_MS = 95_000;

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

  private withReason(s: SessionSummary): SessionSummary {
    const reason = this.d.store.exitReasonOf(s.id);
    return reason && !s.exitReason ? { ...s, exitReason: reason } : s;
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
  // 見張り（一覧の SSE）が動いている間は、見張りが tick ごとに取り直すので、要求の側からは取り直さない
  private agents() { return this.cached("agents", this.watch?.size ? Number.POSITIVE_INFINITY : AGENTS_MS, () => this.fetchAgents()); }
  // claude agents --json の起動は、同時に1本だけにする。見張りの取り直しと要求の側の取り直しが重なっても2本にしない
  private agentsInflight?: Promise<AgentInfo[]>;
  private fetchAgents(): Promise<AgentInfo[]> {
    this.agentsInflight ??= this.d.agents().then((a) => { this.noteAgents(a); return a; }).finally(() => { this.agentsInflight = undefined; });
    return this.agentsInflight;
  }
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
    // 台帳から掃いた後も、覚えている終わりの理由（自動で止めたことなど）を重ねる
    const past = !states || states.has("exited") ? (await this.past()).filter((h) => !seen.has(h.id)).map((h) => this.withReason(h)) : [];
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
    const value = this.fetchAgents();
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
    if (pty && !this.d.startPty) throw new HttpError(400, { error: "terminal sessions are not supported on this node" });
    // 信頼の確認画面で子が止まらないよう、起動の前に cwd（と git のルート）を信頼済みにする（#46）。pty、node、受け口、resume の全部がここを通る。
    // node の子の遅延起動（1通目の send で起動）では、ここから起動まで間が空く。その間に記録が消えても、-p の claude は確認画面を出さない
    await this.d.trust?.(cwd).catch(() => {});
    if (pty) {
      const settings = await lobbySettingsFor(cwd, this.d.lobby);
      const prompt = body.prompt ? withFromLine(caller, this.d.nodeName, body.prompt) : undefined;
      const depth = await this.stampDepth(tracer, child.depth, body.resume);
      // resume のときは、claude を起動する前に会話の件数を数える。起動した後は付け直した後の行も jsonl に書かれ、台帳の行と二重になる。
      // 台帳の番号はこの件数から振り、それより前は messages が jsonl から返す（ノードの再起動で付け直しても前の会話が見える）。
      // fork は新しい id の jsonl がまだ無いので 0（今までどおり、付けた後の分だけ）
      const historyBase = body.resume && !body.fork ? await this.d.history.count(body.resume).catch(() => 0) : 0;
      const driver = await this.d.startPty!({ cwd, prompt, permissionMode: body.permissionMode, model: body.model, resume: body.resume, fork: body.fork, settings, ...pty }, caller);
      this.setDepth(driver.id, depth);
      this.d.store.add(driver, { historyBase });
      // cursor は read_messages の after に渡す値。0 だと resume した前の会話の返事を、今の返事として読んでしまう
      return { id: driver.id, cwd, state: driver.summary().state, kind: driver.kind, depth, cursor: historyBase };
    }
    // sessionId は呼び手から受けない（既にある jsonl と重ねないため）。新規でプロンプトが無いときだけノードが決める
    const sessionId = !body.prompt && !body.resume ? crypto.randomUUID() : undefined;
    // settings は呼び手から受けない。受け口（resume を含む）のときだけ、ノードが書いた受け口の許可を渡す
    const settings = await lobbySettingsFor(cwd, this.d.lobby);
    const opts: StartOptions = { ...body, cwd, sessionId, settings, prompt: body.prompt ? withFromLine(caller, this.d.nodeName, body.prompt) : undefined } as StartOptions;
    const depth = await this.stampDepth(tracer, child.depth, body.resume);
    // pty と同じく、resume では起動する前に会話の件数を数え、台帳の番号をそこから振る。SDK の resume は前の会話を流し直さないので、
    // 数えないと after=0 が付け直した後の分しか返さず、0 から読み直す読み手（epoch が変わったときの Claude Town）から前の会話が消える
    const historyBase = body.resume && !body.fork ? await Promise.resolve().then(() => this.d.history.count(body.resume!)).catch(() => 0) : 0;
    const driver = await this.d.startNode(opts, caller);
    this.setDepth(driver.id, depth);
    this.d.store.add(driver, { historyBase });
    return { id: driver.id, cwd, state: driver.summary().state, kind: driver.kind, depth, cursor: historyBase };
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
    if (past) return { ...this.withReason(past), pending: [], cursor: await this.cursor(id) };
    throw new HttpError(404, { error: "unknown session" });
  }
  // messages?after= と同じ数え方にする。生きているものは台帳の最後の seq、それ以外（端末、終わったもの、過去）は履歴の件数
  private async cursor(id: string): Promise<number | undefined> {
    const live = this.d.store.get(id);
    if (live && live.summary().state !== "exited") return this.d.store.lastSeq(id) ?? 0;
    // cursor は無くても詳細は返す（古い CLI は messages をたどって数える）
    return Promise.resolve().then(() => this.d.history.count(id)).catch(() => undefined);
  }
  // 生きているものは台帳のイベント（seq）を返す。台帳に付けた時点より前（after が historyBase より前）は、jsonl の会話を履歴の位置で返す。
  // 履歴の分を読み切ったページには、続けて台帳のイベントを入れる（空のページを返すと、読み手が境界の手前で止まる）。
  // 応答の epoch は after と next の数え方の印。生きているものは台帳の項目ごと（store.epoch）、それ以外は HISTORY_EPOCH。
  // 前に読んだ応答と epoch が違えば、持っている cursor は今の番号と続いていない（ノードの再起動、付け直し、終了で jsonl の位置に移った）。
  // 読み手は after=0 から読み直す。epoch を見ない読み手（CLI、MCP）は今までどおり
  async messages(id: string, after: number) {
    const liveOne = this.d.store.get(id);
    if (liveOne && liveOne.summary().state !== "exited") {
      const epoch = this.d.store.epoch(id);
      const base = this.d.store.historyBase(id);
      let past: unknown[] = [];
      if (after < base) {
        const limit = Math.min(HISTORY_PAGE, base - after);
        past = (await this.d.history.messages(id, after, limit).catch(() => ({ messages: [] }))).messages.slice(0, limit);
        if (past.length === limit && after + limit < base) return { messages: past, next: after + limit, epoch };
      }
      const events = this.d.store.eventsSince(id, after);
      const next = events.length ? events[events.length - 1]!.seq : past.length ? after + past.length : undefined;
      return { messages: [...past, ...events], next, epoch };
    }
    return { ...(await this.d.history.messages(id, after)), epoch: HISTORY_EPOCH };
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

  // ---- teleport（docs/superpowers/specs/2026-11-12-session-teleport-design.md） ----
  private td(): TeleportDeps {
    if (!this.d.teleport) throw new HttpError(501, { error: "teleport is not available on this node" });
    return this.d.teleport;
  }
  private placeDeps(): PlaceDeps {
    return { git: this.td().git, home: this.d.home ?? homedir(), roots: this.d.roots, lobby: this.d.lobby, places: async () => (await this.places(null, PLACES_MAX_LIMIT)).places };
  }
  private async isLobby(cwd: string): Promise<boolean> {
    const [a, b] = await Promise.all([realpath(resolve(cwd)).catch(() => cwd), realpath(resolve(this.d.lobby)).catch(() => this.d.lobby)]);
    return a === b;
  }
  // 生きている（台帳で終わっていない、または端末で動いている）なら取り込まない
  private async refuseLive(id: string) {
    const live = this.d.store.get(id);
    if ((live && live.summary().state !== "exited") || (await this.d.agents()).some((a) => a.sessionId === id)) {
      throw new HttpError(409, { error: `session ${id} is running on ${this.d.nodeName}`, code: "id_live" });
    }
  }
  // 移動元の説明。下見に使う（bundle は作らない）
  async teleportInfo(id: string) {
    const td = this.td();
    const live = this.d.store.get(id);
    const liveOn = live && live.summary().state !== "exited";
    const term = liveOn ? undefined : (await this.d.agents()).find((a) => a.sessionId === id);
    const s = liveOn ? live.summary() : term ? this.d.terminalFor(term).summary() : await this.d.history.get(id);
    if (!s) throw new HttpError(404, { error: "unknown session" });
    const git = await describeRepo(td.git, s.cwd).catch(() => null);
    return { id, kind: s.kind, state: s.state, capabilities: s.capabilities, title: s.title, permissionMode: s.permissionMode, awaitingFirst: s.awaitingFirst ?? false,
      live: !!(liveOn || term), from: { node: this.d.nodeName, cwd: s.cwd, lobby: await this.isLobby(s.cwd) }, git };
  }
  // 書き出す。fork でなければ move で、止められるもの（ノードの子）は止めてから書き出す。動いている途中なら断る。
  // 止められない端末セッションは、同じ id が2か所で続かないよう fork に切り替えて警告する
  async exportPack(id: string, fork: boolean): Promise<Pack> {
    const td = this.td();
    const info = await this.teleportInfo(id);
    if (info.awaitingFirst) throw new HttpError(409, { error: "the session has no conversation yet", code: "empty" });
    const warnings: string[] = [];
    if (!fork && info.live) {
      const live = this.d.store.get(id);
      if (live && live.capabilities.stop) {
        if (info.state === "running" || info.state === "waiting_permission") throw new HttpError(409, { error: `session is ${info.state}; wait for it or interrupt it, then retry (or use fork)`, code: "busy" });
        await live.stop();
        this.d.store.remove(id);
      } else {
        fork = true;
        warnings.push(`the ${info.kind} session cannot be stopped by ccn, so it was forked instead (new id). Close the original yourself so it does not continue in two places`);
      }
    } else if (!fork) {
      warnings.push(`the source transcript stays on ${this.d.nodeName}; do not resume it there`);
    }
    return exportPack(td, { node: this.d.nodeName, id, cwd: info.from.cwd, lobby: info.from.lobby, fork, title: info.title, permissionMode: info.permissionMode, warnings });
  }
  async exportResponse(id: string, req: Request): Promise<Response> {
    const body = (await req.json().catch(() => ({}))) as { fork?: unknown };
    const pack = await this.exportPack(id, body.fork === true);
    return new Response(encodePack(pack), { headers: { "content-type": PACK_CONTENT_TYPE, "cache-control": "no-store" } });
  }
  // 移動先の下見。移動先のディレクトリを決め（clone を含む）、作業ツリーがきれいかを見る
  async teleportCheck(req: Request) {
    const body = (await req.json().catch(() => ({}))) as CheckInput & { cwd?: unknown };
    if (!body.from || typeof body.from.cwd !== "string") throw new HttpError(400, { error: "from.cwd is required" });
    if (body.cwd !== undefined && typeof body.cwd !== "string") throw new HttpError(400, { error: "cwd must be a string" });
    if (body.id && !body.fork) await this.refuseLive(body.id);
    const dest = await resolveDest({ id: body.id, fork: body.fork, from: body.from, git: body.git ?? null }, body.cwd as string | undefined, this.placeDeps());
    return { node: this.d.nodeName, ...dest };
  }
  // 取り込む。会話と作業ツリーを置き直し、1通目が来るまで claude を起動しないノードの子として台帳に載せる
  async teleportImport(req: Request, url: URL, caller: Caller) {
    const td = this.td();
    const pack = decodePack(new Uint8Array(await req.arrayBuffer()));
    await this.refuseLive(pack.id);
    const r = await importPack({ ...td, place: this.placeDeps() }, pack, { cwd: url.searchParams.get("cwd") ?? undefined });
    const settings = await lobbySettingsFor(r.cwd, this.d.lobby);
    const driver = await this.d.startNode({ cwd: r.cwd, resume: r.id, defer: true, permissionMode: pack.permissionMode as StartOptions["permissionMode"], settings }, caller);
    this.d.store.add(driver);
    return { node: this.d.nodeName, sourceNode: pack.from.node, sourceId: pack.sourceId, fork: pack.fork, ...r };
  }
  // 移動元のノードが進める teleport。下見、（move なら）止める、書き出す、取り込むの順。CLI の接続が切れても最後まで進む
  async teleport(id: string, req: Request, caller: Caller) {
    const body = (await req.json().catch(() => ({}))) as { to?: unknown; fork?: unknown; cwd?: unknown };
    if (typeof body.to !== "string" || !body.to) throw new HttpError(400, { error: "to (peer name) is required" });
    if (body.to === this.d.nodeName) throw new HttpError(400, { error: `the session is already on ${this.d.nodeName}` });
    if (body.cwd !== undefined && typeof body.cwd !== "string") throw new HttpError(400, { error: "cwd must be a string" });
    const to = body.to;
    const fork = body.fork === true;
    const info = await this.teleportInfo(id);
    const check = await this.peerCall(to, "api/teleport/check", JSON.stringify({ id, fork, from: info.from, git: info.git, cwd: body.cwd }), "application/json", caller);
    if (check.status === 404 && !(check.body as { code?: string })?.code) throw new HttpError(502, { error: `${to} does not know teleport (old version?). Run ccn update on ${to}`, stage: "check" });
    if (check.status >= 300) throw new HttpError(check.status, { ...(check.body as object), at: to, stage: "check" });
    const pack = await this.exportPack(id, fork);
    const qs = typeof body.cwd === "string" ? `?cwd=${encodeURIComponent(body.cwd)}` : "";
    const r = await this.peerCall(to, `api/teleport${qs}`, encodePack(pack), PACK_CONTENT_TYPE, caller);
    if (r.status >= 300) {
      const hint = pack.fork ? undefined : `the source session was stopped; resume it on ${this.d.nodeName} with: ccn new ${info.from.cwd} --peer ${this.d.nodeName} --resume ${id}`;
      throw new HttpError(r.status, { ...(r.body as object), at: to, stage: "import", ...(hint ? { hint } : {}) });
    }
    // clone は下見で済んでいるので、取り込みの返事では cloned にならない。下見の分を合わせる
    return { ...(r.body as object), cloned: (check.body as { cloned?: boolean }).cloned === true || (r.body as { cloned?: boolean }).cloned === true };
  }
  private async peerCall(peer: string, rest: string, body: BodyInit, type: string, caller: Caller): Promise<{ status: number; body: unknown }> {
    const [path, search = ""] = rest.split("?");
    const req = new Request(`http://${this.d.nodeName}/${path}${search ? `?${search}` : ""}`, { method: "POST", headers: { "content-type": type }, body });
    const res = await this.d.relay.forward(peer, path!, req, caller, TELEPORT_PEER_MS);
    const text = await res.text();
    let value: unknown;
    try { value = text ? JSON.parse(text) : undefined; } catch { value = { error: text.slice(0, 200) }; }
    return { status: res.status, body: value };
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
