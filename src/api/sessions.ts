// セッションの監視と管理の処理。台帳（生きているもの）、agents（端末）、履歴（過去）を合成し、能力で振る舞いを決める
import { resolve, sep } from "node:path";
import { realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import type { Driver, SessionConfig } from "../engine/driver";
import { PERMISSION_MODES } from "../engine/driver";
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
import { formatAgent, parseAgent } from "../identity/agent-name";
import type { McpOptions } from "../mcp/server";
import { HttpError } from "./errors";
import { lobbySettingsFor, secretBases } from "../lobby/lobby";
import { PlacesScanner, selectPlaces, usageOf } from "../lobby/places";
import { sse } from "./sse";
import { DEPTH_HINT, DEPTH_HOPS, DEPTH_REFUSAL, DepthTracer, MAX_DEPTH, type SessionDepth } from "./depth";
import { ListWatch, type ListFilter } from "./list-watch";
import type { State } from "../sessions/types";
import { ParentNotifier, type NotifyTiming } from "../sessions/notify-parent";
import { succeededReason } from "../sessions/succeed";
import type { AccountChoice } from "../engine/account";

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
  // エージェントが立てた子のターンの終わり、承認待ち、思わぬ終わり方を親のセッションに知らせる（src/sessions/notify-parent.ts）。
  // false で知らせない。無ければ既定の間隔で知らせる（試験は間隔を短くして渡す）
  notifyParent?: false | NotifyTiming;
  // 子のアカウントの選択の結果（src/engine/account.ts の camAccount）。fresh は使い回さずに cam usage を取り直す。無ければ見ない
  account?: (o?: { fresh?: boolean }) => Promise<Pick<AccountChoice, "name" | "none">>;
  // 端末のセッションのアカウント（プロセスの環境から読む。src/engine/account.ts の pidAccount）。無ければ載せない
  terminalAccount?: (a: AgentInfo) => Promise<{ account: string; accountEmail?: string } | undefined>;
  // 引き継ぎ（succeed）で、後継の起動の印を待つ上限。既定 10 秒
  succeedReadyMs?: number;
  log?: (msg: string) => void; // 引き継ぎの記録を出す先。無ければ console.log
};
type CreateBody = Partial<StartOptions> & { cwd?: unknown; terminal?: unknown; name?: unknown; cols?: unknown; rows?: unknown; succeed?: unknown };
// 引き継ぎ済みの前任を覚える数。メモリだけ
const SUCCESSORS_MAX = 256;
const SUCCEED_READY_MS = 10_000;

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
  private notifier?: ParentNotifier;
  constructor(private d: Deps) {
    if (d.notifyParent !== false) {
      const n = new ParentNotifier({ ...d.notifyParent, nodeName: d.nodeName, resolveParent: (s) => this.parentOf(s), historyBase: (id) => d.store.historyBase(id) });
      this.notifier = n;
      d.store.onEvent((drv, ev) => n.observe(drv, ev));
    }
  }

  // 子の parent（agent:<ノード>/<sid8>/<役割>）から、知らせを送る親を決める。同じノードで生きているものだけ。
  // 台帳（node、pty）を先に探し、無ければ端末のセッション。先頭8文字で2つ以上に当たれば決めない。
  // 受け口の子は、受け口ではなく受け口の依頼主に送る。受け口は子を立てて渡したら手を離し、依頼主が子と直接話すため。
  // 親を上へたどって子に戻るなら送らない（子が止まった親を resume すると、親の parent が子になり、知らせが往復し続ける）
  private async parentOf(child: SessionSummary): Promise<Driver | undefined> {
    let a = child.parent ? parseAgent(child.parent) : undefined;
    if (a?.sid && a.node === this.d.nodeName && a.role === "lobby") {
      const sid = a.sid;
      // 受け口のセッションは手が空いて止まっていてもよい。台帳（終わったものも30分残る）、無ければ過去の一覧から親を読む
      const inStore = this.d.store.list().filter((s) => s.id.startsWith(sid));
      const lobbies = inStore.length ? inStore : (await this.past().catch(() => [])).filter((s) => s.id.startsWith(sid));
      a = lobbies.length === 1 && lobbies[0]!.parent ? parseAgent(lobbies[0]!.parent) : undefined;
      if (a?.role === "lobby") return undefined;
    }
    if (!a?.sid || a.node !== this.d.nodeName) return undefined;
    const sid = a.sid;
    const live = this.d.store.list().filter((s) => s.id.startsWith(sid) && s.id !== child.id && s.state !== "exited");
    let parent: Driver | undefined;
    if (live.length > 1) return undefined;
    if (live.length === 1) parent = this.d.store.get(live[0]!.id);
    else {
      const terms = (await this.agents()).filter((t) => t.sessionId?.startsWith(sid) && t.sessionId !== child.id);
      if (terms.length !== 1) return undefined;
      parent = this.d.terminalFor(terms[0]!);
    }
    if (!parent) return undefined;
    // 輪の検査。台帳の親だけをたどる（端末のセッションは parent を持たない）
    let up: SessionSummary | undefined = parent.summary();
    for (let i = 0; up && i < DEPTH_HOPS; i++) {
      const p: ReturnType<typeof parseAgent> = up.parent ? parseAgent(up.parent) : undefined;
      if (!p?.sid || p.node !== this.d.nodeName) break;
      const psid = p.sid;
      if (child.id.startsWith(psid)) return undefined;
      const next: SessionSummary[] = this.d.store.list().filter((s) => s.id.startsWith(psid) && s.state !== "exited");
      up = next.length === 1 ? next[0] : undefined;
    }
    return parent;
  }

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
    return this.withSuccessor(reason && !s.exitReason ? { ...s, exitReason: reason } : s);
  }
  // 引き継がれた前任の終わりの理由を、いまの後継の id にそろえる。もとから終わっていた前任（理由は前のまま）と、
  // 引き継ぎ直した前任（理由は止まった前の後継を指す）でも、一覧と詳細から後継が読めるようにする
  private withSuccessor(s: SessionSummary): SessionSummary {
    const succ = this.successors.get(s.id);
    if (!succ || s.state !== "exited") return s;
    const reason = succeededReason(succ);
    return s.exitReason === reason ? s : { ...s, exitReason: reason };
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
    const live = this.d.store.list().map((s) => this.withSuccessor(this.depths.has(s.id) ? { ...s, depth: this.depths.get(s.id) } : s));
    const seen = new Set(live.map((s) => s.id));
    // PTY の子は `claude agents --json` にも出る。id で除き、端末で /clear して id が変わっても pid で除く
    const ptyPids = new Set(live.filter((s) => s.kind === "pty" && s.state !== "exited" && s.pid).map((s) => s.pid));
    const terms = await Promise.all((await this.agents()).filter((a) => a.sessionId && !seen.has(a.sessionId) && !(a.pid && ptyPids.has(a.pid))).map((a) => this.termSummary(a)));
    for (const t of terms) seen.add(t.id);
    // 台帳から掃いた後も、覚えている終わりの理由（自動で止めたことなど）を重ねる
    const past = !states || states.has("exited") ? (await this.past()).filter((h) => !seen.has(h.id)).map((h) => this.withReason(h)) : [];
    const all = [...live, ...terms, ...past];
    return all.filter((s) => (!parent || s.parent === parent) && (!states || states.has(s.state)));
  }
  // 端末のセッションの要約。アカウントが読めたら足す（読むのは pid ごとに1回で、以後は覚えた値）
  private async termSummary(a: AgentInfo): Promise<SessionSummary> {
    const s = this.d.terminalFor(a).summary();
    const acct = await this.d.terminalAccount?.(a).catch(() => undefined);
    return acct ? { ...s, ...acct } : s;
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
    const body = (await req.json().catch(() => ({}))) as CreateBody;
    if (body.succeed !== undefined && typeof body.succeed !== "boolean") throw new HttpError(400, { error: "succeed must be a boolean" });
    const succeed = body.succeed === true;
    const pty = !succeed && body.terminal === true ? ptyFields(body) : undefined;
    // 深さの上限。呼び手が孫（深さ2）なら断る。as_session を名乗らない呼び手は人と見分けられないので、暴走止めであって防御ではない
    const tracer = this.tracer(caller);
    const child = await tracer.childOf(caller.id);
    if (child.depth > MAX_DEPTH) {
      throw new HttpError(409, { error: `${DEPTH_REFUSAL}（呼び手 ${caller.id} の深さ: ${child.callerDepth}）`, hint: DEPTH_HINT, depth: child.callerDepth, limit: MAX_DEPTH });
    }
    if (succeed) return this.succeed(body, caller, tracer);
    const cwd = await this.placeOf(body.cwd);
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
      return this.created(driver, cwd, depth, historyBase);
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
    return this.created(driver, cwd, depth, historyBase);
  }
  // cwd を決める。省けば受け口。symlink を解いた実体で根と比べる。存在しなければ realpath が失敗する
  private async placeOf(given: unknown): Promise<string> {
    if (given !== undefined && (typeof given !== "string" || !given)) throw new HttpError(400, { error: "cwd must be a non-empty string or omitted (omit for the lobby)" });
    const asked = typeof given === "string" ? given : this.d.lobby;
    const cwd = await realpath(resolve(asked)).catch(() => null);
    if (!cwd) throw new HttpError(400, given === undefined ? { error: "lobby does not exist", lobby: this.d.lobby, hint: "restart the node or run ccn update" } : { error: "cwd does not exist" });
    if (!underRoot(cwd, await this.roots())) throw new HttpError(400, { error: "cwd is outside roots", roots: this.d.roots });
    const st = await stat(cwd).catch(() => null);
    if (!st?.isDirectory()) throw new HttpError(400, { error: "cwd is not a directory" });
    return cwd;
  }
  // 作成の応答。parent と、選んだアカウントを足す。枠の残るアカウントが無かった（cam の choice: none）ときは accountUnavailable で伝える。
  // 1通目を待つ node の子はまだアカウントを選んでいないので、どちらも載らない。ここで読む選択は、起動のときに選んだ結果の使い回し
  private async created(driver: Driver, cwd: string, depth: number, cursor: number) {
    const s = driver.summary();
    const pick = s.awaitingFirst ? undefined : await this.d.account?.().catch(() => undefined);
    return {
      id: driver.id, cwd, state: s.state, kind: driver.kind, depth, cursor,
      ...(s.parent ? { parent: s.parent } : {}),
      ...(s.account ? { account: s.account } : {}), ...(s.accountEmail ? { accountEmail: s.accountEmail } : {}),
      ...(pick?.none ? { accountUnavailable: { nextAvailable: pick.none.nextAvailable } } : {}),
    };
  }

  // ---- 引き継ぎ（succeed）。利用上限などで止まったセッションを、同じ段の後継に引き継ぐ ----
  // 前任（resume）の会話を fork した後継を立て、前任の parent と depth を継がせ、前任の子を後継に付け替えてから、前任を止める。
  // 後継が起動の印を返すまでは何も変えない。付け替えと「引き継ぎ済み」の覚えはメモリだけで、ノードを起動し直すと消える
  // （起動し直すと、子の parent は最初の文の from 行に戻る。#39 の手での付け直しは、その名前で行う）
  private succeeding = new Set<string>();         // 引き継ぎの途中の前任。同じ前任の2つ目の要求を断る
  private successors = new Map<string, string>(); // 引き継ぎ済みの前任の id → 後継の id
  private async succeed(body: CreateBody, caller: Caller, tracer: DepthTracer) {
    if (typeof body.resume !== "string" || !body.resume || body.fork !== true) throw new HttpError(400, { error: "succeed requires resume (the predecessor's session id) and fork: true" });
    const predId = body.resume;
    // 画面の二度押しと、中継の待ち（15秒）が切れた後の送り直しで、後継を2体立てない
    const before = this.successors.get(predId);
    const done = await this.successorOf(predId);
    if (done) throw new HttpError(409, { error: `session ${predId} was already succeeded by ${done}`, code: "already_succeeded", successor: done });
    if (this.succeeding.has(predId)) throw new HttpError(409, { error: `session ${predId} is being succeeded right now`, code: "succeeding", hint: "list the sessions to see the result" });
    this.succeeding.add(predId);
    // before は、会話を残さずに止まった前の後継。前任の子はその後継に付け替えてあるので、そこからも新しい後継へ移す
    try { return await this.succeedLocked(body, predId, caller, tracer, before); } finally { this.succeeding.delete(predId); }
  }
  // 引き継ぎ済みの前任の、続きを持っている後継。後継が台帳で生きているか、後継に会話があるときだけ返す。
  // pty の fork は1通目が届くまで jsonl が無い。1通も受けずに止まった後継（idle-stop、stop_session）は resume できず、
  // 会話は前任にしか無いので、後継として案内せず、前任をもう一度引き継げるようにする。
  // 覚えは消さない（前任の子はその後継の名前になっているので、引き継ぎ直しのときに子を探す手がかりにする）
  private async successorOf(predId: string): Promise<string | undefined> {
    const succ = this.successors.get(predId);
    if (!succ) return undefined;
    const live = this.d.store.get(succ);
    if (live && live.summary().state !== "exited") return succ;
    if (await Promise.resolve().then(() => this.d.history.get(succ)).catch(() => undefined)) return succ;
    return undefined;
  }
  private async succeedLocked(body: CreateBody, predId: string, caller: Caller, tracer: DepthTracer, lost?: string) {
    // 前任を探す。台帳（生きているものと、終わって30分以内のもの）、端末、履歴の順
    const inStore = this.d.store.get(predId);
    const term = inStore ? undefined : (await this.agents()).find((a) => a.sessionId === predId);
    const pred = inStore?.summary() ?? (term ? this.d.terminalFor(term).summary() : await this.d.history.get(predId).catch(() => undefined));
    if (!pred) throw new HttpError(404, { error: "unknown session" });
    if (pred.awaitingFirst) throw new HttpError(409, { error: "the session has no conversation yet", code: "empty" });
    // 省いた項目は前任から継ぐ。cwd を省くと受け口になり、会話が見つからない。permissionMode を継がないと、前任が bypass でも後継が承認待ちで止まる。
    // 種類は、前任が pty か端末なら pty。履歴だけの前任は種類が分からないので node（呼び手が terminal: true を渡せば pty）
    if (body.terminal !== undefined && typeof body.terminal !== "boolean") throw new HttpError(400, { error: "terminal must be a boolean" });
    if (body.terminal === true && !this.d.startPty) throw new HttpError(400, { error: "terminal sessions are not supported on this node" });
    const wantPty = body.terminal ?? (!!this.d.startPty && (pred.kind === "pty" || pred.kind === "terminal"));
    const title = (inStore || term) && typeof pred.title === "string" && pred.title.trim() && pred.title.length <= 200 ? pred.title : undefined;
    const pty = wantPty ? ptyFields({ name: body.name ?? title, cols: body.cols, rows: body.rows }) : undefined;
    if (body.cwd === undefined && !pred.cwd) throw new HttpError(400, { error: "cwd is required: the predecessor's directory is not recorded" });
    const cwd = await this.placeOf(body.cwd ?? pred.cwd);
    const permissionMode = body.permissionMode ?? (pred.permissionMode as StartOptions["permissionMode"]);
    const model = body.model ?? pred.model;
    // 後継は呼び手の子ではなく、前任の代わり。parent と depth は前任のものを継ぐ（呼び手が名乗らなくても local にならない）。前任に parent が無いときだけ呼び手を使う
    const parent = pred.parent ?? caller.id;
    const depth = (await tracer.of({ id: predId, cwd: pred.cwd, parent: pred.parent }).catch(() => undefined))?.depth ?? 0;
    // アカウントは使い回さずに取り直す。枠の残るアカウントが無ければ、同じく止まる後継を立てて前任を止めることになるので、何も触らずに断る
    const pick = await this.d.account?.({ fresh: true }).catch(() => undefined);
    if (pick?.none) throw new HttpError(409, { error: "no account has quota left; the successor would stop the same way", code: "no_account", nextAvailable: pick.none.nextAvailable });
    await this.d.trust?.(cwd).catch(() => {});
    const settings = await lobbySettingsFor(cwd, this.d.lobby);
    const prompt = body.prompt ? withFromLine(caller, this.d.nodeName, body.prompt) : undefined;
    const as: Caller = { ...caller, id: parent };
    let driver: Driver;
    let cursor = 0;
    let forked: string | undefined;
    if (pty) {
      driver = await this.d.startPty!({ cwd, prompt, permissionMode, model, resume: predId, fork: true, settings, ...pty }, as);
    } else {
      // node の後継は、SDK の forkSession で会話を写して id を先に決めてから、その id を resume する。
      // query() の fork は、最初の文が無いと init が来ず、NodeDriver が前任の id を名乗る（台帳で前任の項目を置き換えてしまう）
      const fns = this.d.teleport?.fns;
      if (!fns) throw new HttpError(400, { error: "succeed without terminal is not supported on this node", hint: "pass terminal: true" });
      forked = (await fns.forkSession(predId, pred.cwd ? { dir: pred.cwd } : undefined)).sessionId;
      try {
        cursor = await Promise.resolve().then(() => this.d.history.count(forked!)).catch(() => 0);
        driver = await this.d.startNode({ cwd, resume: forked, defer: !prompt, prompt, permissionMode, model, settings }, as);
      } catch (e) {
        await fns.deleteSession(forked, pred.cwd ? { dir: pred.cwd } : undefined).catch(() => {});
        throw e;
      }
    }
    // 後継の id は新しいはず。前任の id のまま台帳に載せると、前任の項目を置き換え、下の「前任を止める」が後継を止める
    let failed = driver.id === predId ? "the successor came up with the predecessor's id" : undefined;
    if (!failed) {
      this.setDepth(driver.id, depth);
      this.d.store.add(driver, { historyBase: cursor }); // pty の hooks は台帳から Driver を引くので、起動の印を待つ前に載せる
      const ok = driver.summary().state !== "exited" && (driver.started ? await driver.started(this.d.succeedReadyMs ?? SUCCEED_READY_MS) : true);
      if (!ok) failed = driver.summary().exitReason ?? "claude gave no sign of starting in time";
    }
    if (failed) {
      // 後継が立たなかった。後継を片付け、前任と子はそのままにする
      this.notifier?.suppress(driver.id);
      try { await driver.stop("the successor did not start").catch(() => {}); if (driver.id !== predId) this.d.store.remove(driver.id); } finally { this.notifier?.clear(driver.id); }
      if (driver.id !== predId) this.depths.delete(driver.id);
      if (forked) await this.d.teleport?.fns.deleteSession(forked, pred.cwd ? { dir: pred.cwd } : undefined).catch(() => {});
      throw new HttpError(502, { error: "the successor did not start; the predecessor and its children were left as they were", code: "successor_failed", reason: failed });
    }
    const adopted = await this.adopt(lost ? [predId, lost] : [predId], driver.id);
    const retired = await this.retire(predId, !!term, driver.id);
    this.successors.set(predId, driver.id);
    if (this.successors.size > SUCCESSORS_MAX) this.successors.delete(this.successors.keys().next().value!);
    this.expireHistory();
    // 付け替えはメモリだけなので、ノードを起動し直した後に手で付け直すときの手がかりをログに残す
    (this.d.log ?? console.log)(`succeed: ${predId} -> ${driver.id} (parent ${parent}, depth ${depth}, adopted ${adopted.join(",") || "-"}, stopped ${retired.stopped})`);
    return { ...(await this.created(driver, cwd, depth, cursor)), succeeded: { from: predId, ...retired, adopted } };
  }
  // 前任の子を後継の子にする。台帳にあるセッション（終わって30分以内のものを含む）のうち、知らせの宛先（parentOf）が前任になるものが対象。
  // parent が前任を名乗るものは、役割はそのままで後継の名前にする。受け口を挟んだ子は、受け口のセッションが台帳にあれば受け口の parent が
  // 付け替わるので触らない。受け口が台帳から掃かれていれば（履歴の parent は書き換えられない）、子を後継の直接の子にする
  // from は前任の id。会話を残さずに止まった前の後継があれば、それも入る（子はその名前になっている）
  private async adopt(from: string[], succId: string): Promise<string[]> {
    const node = this.d.nodeName;
    const olds = new Set(from.map((id) => id.slice(0, 8)));
    const all = this.d.store.list();
    let past: SessionSummary[] | undefined;
    const out: string[] = [];
    for (const s of all) {
      if (from.includes(s.id) || s.id === succId) continue;
      const a = s.parent ? parseAgent(s.parent) : undefined;
      if (!a?.sid || a.node !== node) continue;
      let role: string | undefined;
      if (olds.has(a.sid)) role = a.role;
      else if (a.role === "lobby") {
        const lsid = a.sid;
        if (all.some((x) => x.id.startsWith(lsid))) continue;
        past ??= await this.past().catch(() => []);
        const lobbies = past.filter((x) => x.id.startsWith(lsid));
        const lp = lobbies.length === 1 && lobbies[0]!.parent ? parseAgent(lobbies[0]!.parent) : undefined;
        if (lp?.sid && olds.has(lp.sid) && lp.node === node && lp.role !== "lobby") role = lp.role;
      }
      const d = role === undefined ? undefined : this.d.store.get(s.id);
      if (!d?.setParent) continue;
      d.setParent(formatAgent(node, succId, role));
      this.d.store.touch(s.id);
      out.push(s.id);
    }
    return out;
  }
  // 前任を止める。残すと、枠が戻ったあとに文が届いて前任が起き、後継と同じ作業を二重に進める。
  // stopped は、この後に前任がこのノードで動いていないこと（もとから終わっていた前任も true）。止められなかったときは note に理由を入れる。
  // 終わりの理由に後継の id を入れる。親への知らせ（notify-parent.ts）は、この理由を見て「引き継がれた」と伝える
  private async retire(predId: string, terminal: boolean, succId: string): Promise<{ stopped: boolean; note?: string }> {
    const live = this.d.store.get(predId);
    if (live) {
      if (live.summary().state === "exited") return { stopped: true };
      if (!live.capabilities.stop) return { stopped: false, note: "the predecessor cannot be stopped by ccn; stop it yourself so it does not continue in two places" };
      try { await live.stop(succeededReason(succId)); } catch (e) { return { stopped: false, note: `stopping the predecessor failed: ${e instanceof Error ? e.message : String(e)}` }; }
      return live.summary().state === "exited" ? { stopped: true } : { stopped: false, note: "the predecessor did not stop; stop it yourself so it does not continue in two places" };
    }
    if (terminal) return { stopped: false, note: "the predecessor is a terminal session, which ccn cannot stop; close it yourself so it does not continue in two places" };
    return { stopped: true };
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
    if (driver) {
      const term = driver.kind === "terminal" ? (await this.agents()).find((x) => x.sessionId === id) : undefined;
      const s = term ? await this.termSummary(term) : this.withSuccessor(driver.summary());
      return { ...s, ...(this.depths.has(driver.id) ? { depth: this.depths.get(driver.id) } : {}), pending: driver.pending(), cursor: await this.cursor(id) };
    }
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
    if (driver.summary().state === "exited") {
      // 引き継がれた前任は resume を勧めない（後継と同じ作業を二重に進めるため）。後継の id を返す
      const succ = await this.successorOf(driver.id);
      throw new HttpError(409, succ ? { error: "session exited", hint: `succeeded by ${succ}; send to that session and do not resume this one`, successor: succ } : { error: "session exited", hint: "resume" });
    }
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
    const body = (await req.json().catch(() => ({}))) as { permissionMode?: unknown; model?: unknown };
    const c: SessionConfig = {};
    if (body.permissionMode !== undefined) {
      if (typeof body.permissionMode !== "string" || !(PERMISSION_MODES as readonly string[]).includes(body.permissionMode)) {
        throw new HttpError(400, { error: `permissionMode must be one of ${PERMISSION_MODES.join(", ")}` });
      }
      c.permissionMode = body.permissionMode;
    }
    if (body.model !== undefined) {
      // claude の引数（--model）にもなるので、名前に使う文字だけを受ける（opus、claude-sonnet-5-5、claude-fable-5[1m] など）
      if (typeof body.model !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:\-\[\]]{0,99}$/.test(body.model)) throw new HttpError(400, { error: "model must be a model name or alias, e.g. sonnet or claude-sonnet-5-5" });
      c.model = body.model;
    }
    if (c.model === undefined && c.permissionMode === undefined) return driver.summary();
    if (driver.summary().state === "exited") throw new HttpError(409, { error: "session exited", hint: "resume" });
    if (driver.configure) await driver.configure(c);
    else if (c.model === undefined && driver.setPermissionMode) await driver.setPermissionMode(c.permissionMode!);
    else throw new HttpError(409, { error: `${c.model !== undefined ? "model" : "permission mode"} cannot be changed on this session`, kind: driver.kind });
    return driver.summary();
  }
  async remove(id: string) {
    const driver = await this.must(id);
    if (!driver.capabilities.stop) throw new HttpError(409, { error: "capability stop not available" });
    // API で止めた子の終わりは親に知らせない。stop_session は呼び手を名乗らないので、親が止めたのか人が止めたのかは見分けない
    this.notifier?.suppress(driver.id);
    try {
      await driver.stop();
      this.d.store.remove(id);
    } finally {
      this.notifier?.clear(driver.id);
    }
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
  async exportPack(id: string, fork: boolean, caller: Caller): Promise<Pack> {
    const td = this.td();
    const info = await this.teleportInfo(id);
    this.refuseBusy(id, info, fork, caller);
    const warnings: string[] = [];
    if (!fork && info.live) {
      const live = this.d.store.get(id);
      if (live && live.capabilities.stop) {
        this.notifier?.suppress(id); // 移すために止めた。親に「終わった」と知らせない
        try {
          await live.stop();
          this.d.store.remove(id);
        } finally {
          this.notifier?.clear(id);
        }
      } else {
        fork = true;
        warnings.push(`the ${info.kind} session cannot be stopped by ccn, so it was forked instead (new id). Close the original yourself so it does not continue in two places`);
      }
    } else if (!fork) {
      warnings.push(`the source transcript stays on ${this.d.nodeName}; do not resume it there`);
    }
    return exportPack(td, { node: this.d.nodeName, id, cwd: info.from.cwd, lobby: info.from.lobby, fork, title: info.title, permissionMode: info.permissionMode, warnings });
  }
  // 呼び手がそのセッション自身か（agent:<このノード>/<id の先頭8文字>/...）。ノードの子が自分を移すとき、走っているターンは teleport を呼んだ自分のものなので止めてよい
  private isSelf(id: string, caller: Caller): boolean {
    const a = parseAgent(caller.id);
    return !!a && a.node === this.d.nodeName && !!a.sid && id.startsWith(a.sid);
  }
  // 運ぶ会話が無いもの、move で動いている途中のものを断る。下見（clone を含む）より前に見る
  private refuseBusy(id: string, info: { awaitingFirst: boolean; live: boolean; state: string }, fork: boolean, caller: Caller) {
    if (info.awaitingFirst) throw new HttpError(409, { error: "the session has no conversation yet", code: "empty" });
    const live = this.d.store.get(id);
    if (!fork && info.live && live?.capabilities.stop && (info.state === "running" || info.state === "waiting_permission") && !this.isSelf(id, caller)) {
      throw new HttpError(409, { error: `session is ${info.state}; wait for it or interrupt it, then retry (or use fork)`, code: "busy" });
    }
  }
  async exportResponse(id: string, req: Request, caller: Caller): Promise<Response> {
    const body = (await req.json().catch(() => ({}))) as { fork?: unknown };
    const pack = await this.exportPack(id, body.fork === true, caller);
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
    // create と同じく、起動の前に cwd（と git のルート）を信頼済みにする（#46）。clone した場所は未信頼のことがある
    await this.d.trust?.(r.cwd).catch(() => {});
    const settings = await lobbySettingsFor(r.cwd, this.d.lobby);
    const driver = await this.d.startNode({ cwd: r.cwd, resume: r.id, defer: true, permissionMode: pack.permissionMode as StartOptions["permissionMode"], settings }, caller);
    this.d.store.add(driver);
    // 1通も届かないまま30分たつと台帳から消える（store.ts）。会話と作業ツリーは残るので、そのときの再開の手順も返す
    const resume = `ccn new ${r.cwd} --peer ${this.d.nodeName} --resume ${r.id}`;
    return { node: this.d.nodeName, sourceNode: pack.from.node, sourceId: pack.sourceId, fork: pack.fork, resume, ...r };
  }
  // 移動元のノードが進める teleport。下見、（move なら）止める、書き出す、取り込むの順。CLI の接続が切れても最後まで進む
  async teleport(id: string, req: Request, caller: Caller) {
    const body = (await req.json().catch(() => ({}))) as { to?: unknown; fork?: unknown; cwd?: unknown; dryRun?: unknown; subtree?: unknown };
    // 子孫ごと移す（subtree）と計画だけ返す（dryRun）は持っていない。黙って無視すると、計画のつもりの要求で本当に移してしまうので、何もせずに断る。false は付けないのと同じ
    for (const k of ["subtree", "dryRun"] as const) {
      if (body[k] !== undefined && body[k] !== false) throw new HttpError(501, { error: `${k} is not supported by ${this.d.nodeName}; teleport moves one session at a time`, code: "unsupported" });
    }
    if (typeof body.to !== "string" || !body.to) throw new HttpError(400, { error: "to (peer name) is required" });
    if (body.to === this.d.nodeName) throw new HttpError(400, { error: `the session is already on ${this.d.nodeName}` });
    if (body.cwd !== undefined && typeof body.cwd !== "string") throw new HttpError(400, { error: "cwd must be a string" });
    const to = body.to;
    const fork = body.fork === true;
    const info = await this.teleportInfo(id);
    this.refuseBusy(id, info, fork, caller);
    const check = await this.peerCall(to, "api/teleport/check", JSON.stringify({ id, fork, from: info.from, git: info.git, cwd: body.cwd }), "application/json", caller);
    if (check.status === 404 && (check.body as { error?: string })?.error === "not found") throw new HttpError(502, { error: `${to} does not know teleport (old version?). Run ccn update on ${to}`, stage: "check" });
    if (check.status >= 300) throw new HttpError(check.status, { ...(check.body as object), at: to, stage: "check" });
    const pack = await this.exportPack(id, fork, caller);
    // 取り込みでは探し直さず、下見で決まった場所（リポジトリの最上位か、git でなければ cwd）を渡す。下見の clone が places の覚えに載っていないことがあるため
    const checked = check.body as { top?: string | null; cwd?: string };
    const at = typeof body.cwd === "string" ? body.cwd : checked.top ?? checked.cwd;
    const qs = at ? `?cwd=${encodeURIComponent(at)}` : "";
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
