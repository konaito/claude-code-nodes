// PTY で対話モードの claude を動かす PtyDriver。人が画面（xterm.js など）で同じ端末を見て打てるセッション。
// 出力をヘッドレスの端末（src/engine/screen.ts）に流し、繋いだ画面に今の画面を replay で渡す。続きから読むために、出力の末尾（既定 2MB）も覚える。承認、ターンの終わり、状態は、--settings で注入した hooks（http）から受ける。
// 画面の文字は読まない。hooks が届かない操作（端末での Esc など）は `claude agents --json` の状態で照らし合わせる
import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Driver, RawEvent } from "./driver";
import { BusyError, CommandRefusedError, ExitedError, NotFoundError, RestartFailedError } from "./driver";
import type { SessionConfig } from "./driver";
import type { AgentInfo } from "./agents";
import type { Capabilities, PendingPermission, PermissionAnswer, SessionSummary, State } from "../sessions/types";
import { AsyncQueue } from "../sessions/async-queue";
import { Screen } from "./screen";
import { PTY_HOOK_PATH, PTY_HOOK_TOKEN_HEADER } from "../names";

// 端末の口の枠。offset はそのフレームの末尾のバイト位置（0 からの通し番号）。SSE の id にする
export type TermFrame =
  | { type: "size"; cols: number; rows: number; epoch: number }
  | { type: "replay" | "data"; b64: string; offset: number }
  | { type: "exit"; code: number | null; reason: string };

// PTY の子プロセス。本物は Bun.Terminal（bunPtySpawn）、試験は偽物
export type PtyProc = { pid: number; write(data: string | Uint8Array): void; resize(cols: number, rows: number): void; kill(signal?: NodeJS.Signals): void; exited: Promise<number | null> };
export type PtySpawn = (argv: string[], o: { cwd: string; env: Record<string, string>; cols: number; rows: number; onData: (d: Uint8Array) => void }) => PtyProc;

export type PtyStartOptions = {
  cwd: string;
  prompt?: string;          // from 行の付いた最初の文。claude の引数で渡す（起動直後の画面と競合しない）
  permissionMode?: string;
  model?: string;
  resume?: string;
  fork?: boolean;
  name?: string;            // claude の --name。一覧の title になる
  cols?: number;
  rows?: number;
  settings?: string;        // 受け口の設定ファイル。hooks と1つのファイルに合成する
};
export type PtyDeps = {
  spawn: PtySpawn;
  hookBase: string;         // hooks の宛先。ノード自身（http://127.0.0.1:<port>）
  caller?: string;          // 立てた呼び手。一覧の parent
  account?: string;         // 起動のときに選んだアカウント（cam のコマンド名）。一覧の account
  accountEmail?: string;
  claudePath?: string;
  agentInfo?: (pid: number) => Promise<AgentInfo | undefined>; // 端末で答えた承認や Esc の後に状態を照らし合わせる
  maxBuffer?: number;       // 覚える末尾のバイト数。既定 2MB
  env?: Record<string, string | undefined>;
  reconcileDelayMs?: number;
  tmp?: string;             // 設定ファイルを置く場所。既定は OS の tmp
  pasteDelayMs?: number;
  readyTimeoutMs?: number;  // send が claude の起動（SessionStart と入力の受け付け）を待つ上限。既定 10 秒（中継の応答待ち15秒より短くする）
  inputTimeoutMs?: number;  // 起動から入力の受け付け（ESC[?2004h）を待つ上限。過ぎたら溜めた入力を流す。既定 10 秒
  // 会話の行（SDK の getSessionMessages）。hooks は途中の文を運ばないので、hooks が届くたびにこれを読み、まだ出していない行を流す。
  // 無ければ hooks から組み立てる（途中の文は出ない）
  // dir は会話の置き場（起動した cwd）。渡すと全部のプロジェクトを探さずに済む
  transcript?: (id: string, dir?: string) => Promise<TranscriptLine[]>;
  // PreToolUse と PostToolUse の後、その道具の tool_use か tool_result の行が出るまで読み直す間隔（ミリ秒）。全部待っても出なければあきらめる
  chaseDelaysMs?: number[];
  localDelaysMs?: number[];
  // 会話のファイル（jsonl）があるか。起動し直すときに --resume と --session-id を分ける（SDK の getSessionInfo）。
  // /context だけを打った会話は jsonl に system の行しか無く、transcript は空を返すが、--session-id は使えない（2026-11-21 に実測）
  exists?: (id: string, dir?: string) => Promise<boolean>;
};
export type TranscriptLine = { type: string; uuid: string; message?: unknown; timestamp?: string };

const MAX_BUFFER = 2 * 1024 * 1024;
// claude が入力を読み始めると出す、bracketed paste を有効にする列
const INPUT_ON = "\x1b[?2004h";
const REPLAY_CHUNK = 64 * 1024;
// 画面に送る data の間隔の下限。間に届いた出力は1つの data にまとめる。17ms で1秒あたり60回以下になる（#25）。
// 前の data から間が空いていれば、待たずにすぐ送る（打った文字の表示を遅らせない）
const DATA_GAP_MS = 17;
const SUB_LIMIT = 8 * 1024 * 1024; // 1つの画面に溜めてよいバイト数。超えたら切り、画面は after で繋ぎ直す
// PreToolUse は道具を使い始めた印。tool_use の行はこの時点で jsonl にある（2026-11-13 に実測、#43）。無いと承認の要らない道具の tool_use が、道具が終わるまで読まれない
// PreCompact と PostCompact は /compact の間の状態と、終わった後の出力の読み込みに使う（#64）
const HOOK_EVENTS = ["UserPromptSubmit", "PreToolUse", "PermissionRequest", "PostToolUse", "PostToolUseFailure", "Stop", "StopFailure", "Notification", "PreCompact", "PostCompact"] as const;
const PERMISSION_HOOK_TIMEOUT_S = 7 * 24 * 3600; // 承認は人が答えるまで待つ。切れると端末の承認画面だけが残る
const EVENT_HOOK_TIMEOUT_S = 10;
// PostToolUse の時点では tool_result の行はまだ jsonl に無い（2026-11-13 に実測、#43）。書かれるまで、この間隔で読み直す。合わせて約4.6秒
const CHASE_DELAYS_MS = [150, 300, 600, 1200, 2400];
// 組み込みコマンドの出力（<local-command-stdout> の行）は hook を伴わない（/context など）。貼った後、この間隔で読み直す。合わせて約9秒
const LOCAL_DELAYS_MS = [300, 600, 1200, 2400, 4800];
// 対話の claude では、設定ファイルに保存されてしまうコマンド（公式の文書 model-config、fast-mode。/model は API が先に断る）
const PERSISTING_COMMANDS = new Set(["effort", "fast"]);
const ANSI = /\x1b\[[0-9;?]*[ -\/]*[@-~]/g;

type Waiting = { p: PendingPermission; resolve: (out: unknown) => void };
type Sub = { q: AsyncQueue<TermFrame>; bytes: number };

const b64 = (u: Uint8Array) => Buffer.from(u.buffer, u.byteOffset, u.byteLength).toString("base64");
const sameInput = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

// 起動する claude の環境。ノード自身が Claude Code の中で動いているとき（試験）の変数を子に渡さない
export function childEnv(base: Record<string, string | undefined>): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(base)) {
    if (v === undefined || k === "CLAUDECODE" || k.startsWith("CLAUDE_CODE_")) continue;
    env[k] = v;
  }
  env.TERM = "xterm-256color";
  env.COLORTERM = "truecolor";
  return env;
}

// hooks を足した設定。受け口の設定があれば、その hooks の後ろに足す。
// SessionStart は command の hook しか使えないので curl で送る。token は引数に出さず、0600 のヘッダのファイル（headerFile）から読ませる
export function ptySettings(hookUrl: string, token: string, headerFile: string, base: Record<string, unknown> = {}): Record<string, unknown> {
  const hooks = { ...((base.hooks as Record<string, unknown[]>) ?? {}) };
  for (const e of HOOK_EVENTS) {
    const h = { type: "http", url: hookUrl, timeout: e === "PermissionRequest" ? PERMISSION_HOOK_TIMEOUT_S : EVENT_HOOK_TIMEOUT_S, headers: { [PTY_HOOK_TOKEN_HEADER]: token } };
    hooks[e] = [...(hooks[e] ?? []), { hooks: [h] }];
  }
  const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
  const curl = `curl -s -m 5 -X POST -H 'content-type: application/json' -H @${q(headerFile)} --data-binary @- ${q(hookUrl)} >/dev/null 2>&1; true`;
  hooks.SessionStart = [...(hooks.SessionStart ?? []), { hooks: [{ type: "command", command: curl, timeout: EVENT_HOOK_TIMEOUT_S }] }];
  return { ...base, hooks };
}

export function ptyArgv(claude: string, id: string, settingsFile: string, o: PtyStartOptions): string[] {
  const a = [claude];
  // --session-id は resume と一緒には渡せない。fork のときは新しい id を渡す
  if (o.resume) { a.push("--resume", o.resume); if (o.fork) a.push("--fork-session", "--session-id", id); }
  else a.push("--session-id", id);
  a.push("--settings", settingsFile);
  if (o.permissionMode) a.push("--permission-mode", o.permissionMode);
  if (o.model) a.push("--model", o.model);
  if (o.name) a.push("--name", o.name);
  if (o.prompt) a.push(o.prompt);
  return a;
}

export class PtyDriver implements Driver {
  readonly kind = "pty" as const;
  id = "";
  get capabilities(): Capabilities {
    const on = this.state !== "exited";
    return { send: on, permissions: on, interrupt: on, stop: on, events: on, terminal: true };
  }
  readonly token = crypto.randomUUID() + crypto.randomUUID();
  private state: State = "idle";
  private proc?: PtyProc;
  private out = new AsyncQueue<RawEvent>();
  private waiting = new Map<string, Waiting>();
  private chunks: Uint8Array[] = [];
  private bufStart = 0; // chunks[0] の先頭のバイト位置
  private end = 0;      // 書かれた末尾のバイト位置
  private subs = new Set<Sub>();
  private cols: number;
  private rows: number;
  private startedAt = Date.now();
  private lastActivityAt = Date.now();
  private permissionMode?: string;
  private exitReason?: string;
  private stopReason?: string; // stop に渡された理由。終了コードから作る理由より優先する
  private lastViewAt = 0;      // 端末の画面の接続と切断の最後の時刻（手が空いた子を止める仕組みが動きとして数える）
  private exitCode: number | null = null;
  private dir?: string;
  private screen: Screen;
  private reconcileTimer?: ReturnType<typeof setTimeout>;
  private exitedP?: Promise<void>;
  // claude の画面が入力を受けられるようになった（SessionStart が届いた）。それより前に貼り付けると文が落ちる（2026-11-12 に実機で確認）
  private readyResolve!: () => void;
  private ready = new Promise<void>((r) => { this.readyResolve = r; });
  // claude が入力を読み始めた（ESC[?2004h が出た）。SessionStart の hook はこれより 0.3〜1.4 秒前に来るので、
  // SessionStart だけを待って貼ると、貼った文は入力欄に入るが Enter が捨てられる（#26、2026-11-12 に4並列で実測）。
  // 信頼の確認の画面でも出る。それまでの画面のキー入力は溜めておき、出たら流す
  private inputOn = false;
  private inputOnResolve!: () => void;
  private inputReady = new Promise<void>((r) => { this.inputOnResolve = r; });
  private inputTimer?: ReturnType<typeof setTimeout>;
  private early: Uint8Array[] = [];
  private scanTail = "";
  private seenLines = new Set<string>();     // 流した会話の行の uuid
  // 会話の読み込みは、走っている1本と、その後に続ける1本だけにする。getSessionMessages は毎回 jsonl を全部読むので、hooks が重なっても読む回数を増やさない
  private syncRun?: Promise<boolean>;
  private syncNext?: Promise<boolean>;
  private wanted = new Set<string>();        // 行が出るのを待っている道具（"use:<id>" か "result:<id>"）。行を流したら消す
  private fallbackTexts: string[] = [];      // 行が書かれる前に Stop の hook の文で補った分。後から同じ文の行が来たら流さない
  private turnTexts: string[] = [];          // このターンに流した文
  private unsent: Uint8Array[] = []; // まだ画面に送っていない出力。末尾は this.end
  private flushTimer?: ReturnType<typeof setTimeout>;
  private lastFlushAt = 0;
  // 今のターンの UserPromptSubmit を見た。見る前（起動の引数の文がまだ届いていない間）に agents が idle と言っても、ターンは終わっていない
  private turnSeen = false;
  private parent?: string; // 立てた呼び手。引き継ぎで付け替わる（setParent）
  private conversationId?: string; // /clear の後の会話の id（SessionStart の source=clear の session_id）
  private convId() { return this.conversationId ?? this.id; }
  private model?: string;          // 今のモデル。起動の指定、SessionStart の hook の model、応答の行の message.model の順に新しいもので替える
  private modelAt = 0;             // model を決めた時刻。これより古い応答の行では替えない
  private settingsFile?: string;
  private gen = 0;                 // 起動したプロセスの通し番号。起動し直す前のプロセスの終わりを数えない
  private restarting = false;      // configure が起動し直している間。前のプロセスの hook を受けない
  private probation?: number;
  private procDead = false;        // 今の gen のプロセスが終わった      // 起動し直して印を待っているプロセスの gen。その間に終わっても finish しない

  private constructor(private opts: PtyStartOptions, private deps: PtyDeps) {
    this.cols = opts.cols ?? 120;
    this.rows = opts.rows ?? 40;
    this.permissionMode = opts.permissionMode;
    this.model = opts.model;
    this.screen = new Screen(this.cols, this.rows);
    this.parent = deps.caller;
  }

  static async start(opts: PtyStartOptions, deps: PtyDeps): Promise<PtyDriver> {
    const d = new PtyDriver(opts, deps);
    d.id = opts.resume && !opts.fork ? opts.resume : crypto.randomUUID();
    // 設定は秘密（hooks の token）を含むので、引数にせず 0600 のファイルで渡す
    d.dir = await mkdtemp(join(deps.tmp ?? tmpdir(), "ccn-pty-"));
    const base = opts.settings ? (JSON.parse(await readFile(opts.settings, "utf8")) as Record<string, unknown>) : {};
    const file = join(d.dir, "settings.json");
    const headerFile = join(d.dir, "hook-headers");
    await writeFile(headerFile, `${PTY_HOOK_TOKEN_HEADER}: ${d.token}\n`, { mode: 0o600 });
    await writeFile(file, JSON.stringify(ptySettings(`${deps.hookBase}${PTY_HOOK_PATH}/${d.id}`, d.token, headerFile, base)), { mode: 0o600 });
    d.settingsFile = file;
    if (opts.prompt) d.state = "running";
    try {
      d.spawnProc(opts);
    } catch (e) {
      await rm(d.dir, { recursive: true, force: true }).catch(() => {});
      throw e;
    }
    return d;
  }
  // claude を起動する。起動し直し（configure）でも使う。前のプロセスの終わりは finish に数えない（gen で見分ける）
  private spawnProc(o: PtyStartOptions, sessionId = this.id): { gen: number; exited: Promise<void> } {
    const gen = ++this.gen;
    this.proc = this.deps.spawn(ptyArgv(this.deps.claudePath ?? "claude", sessionId, this.settingsFile!, o), {
      cwd: o.cwd, env: childEnv(this.deps.env ?? process.env), cols: this.cols, rows: this.rows, onData: (u) => this.onData(u),
    });
    // 版が変わって ESC[?2004h が出なくなっても止まらないよう、上限を過ぎたら受け付けたものとして流す
    this.inputTimer = setTimeout(() => this.markInputOn(), this.deps.inputTimeoutMs ?? 10_000);
    this.procDead = false;
    const end = (code: number | null, reason: string) => {
      if (gen === this.gen) this.procDead = true;
      if (gen !== this.gen) return;            // 起動し直す前のプロセス
      if (gen === this.probation) return;      // 起動し直して確かめている間。configure が前の設定に戻す
      this.finish(code, this.stopReason ?? reason);
    };
    this.exitedP = this.proc.exited.then((code) => end(code, code === 0 || code === null ? "ended" : `exit ${code}`), (e) => end(null, String(e)));
    return { gen, exited: this.exitedP };
  }

  // モデルと権限モードを替える（#64）。対話の claude には、確かめられる替え方が無い。
  // `/model <名前>` は ~/.claude/settings.json の既定まで書き換え、Shift+Tab は hook も statusLine も出さず、着いたかが分からない（2026-11-21 に実測）。
  // そこで待機中のときだけ、同じ id で `--resume <id> --model <名前> --permission-mode <モード>` として起動し直す。会話がまだ無ければ `--session-id <id>` で起動する
  // （会話の無い id を --resume すると claude はすぐ終わる）。端末の画面、SSE、台帳の項目はそのまま続く。
  // 裏のシェルとサブエージェント、起動の指定ではないセッションだけの設定は消える。起動の印が出なければ、前のモデルとモードで起動し直す
  async configure(c: SessionConfig) {
    if (this.state === "exited") throw new ExitedError(this.exitReason);
    if (this.restarting) throw new BusyError("session is restarting; try again shortly");
    if (!(await this.started(this.deps.readyTimeoutMs ?? 10_000))) throw new BusyError("claude has not started yet; if the terminal shows a trust prompt, answer it there first");
    if (this.state !== "idle" || this.waiting.size) throw new BusyError("session is busy; change the model or permission mode while it is idle (interrupt it first)");
    const prev: SessionConfig = { model: this.opts.model, permissionMode: this.permissionMode };
    const next: SessionConfig = { model: c.model ?? prev.model, permissionMode: c.permissionMode ?? prev.permissionMode };
    if (await this.respawn(next)) return;
    const alive = () => (this.state as State) !== "exited";
    if (alive() && (await this.respawn(prev))) throw new RestartFailedError("claude did not start with the new settings; restarted with the previous ones", true);
    // 前の設定でも起動しなかった。プロセスが残っていれば止め、もう終わっていれば（確かめの間に終わった分は finish していない）ここで終える
    if (alive()) this.finish(null, this.stopReason ?? "restart failed"); // 失敗した起動のプロセスは spawnAndWait が止めてある
    throw new ExitedError("restart failed");
  }
  private async respawn(c: SessionConfig): Promise<boolean> {
    this.restarting = true;
    try {
      const old = this.proc!;
      const oldExited = this.exitedP!;
      this.gen++; // 前のプロセスの終わりを finish に数えない
      clearTimeout(this.inputTimer);
      old.kill("SIGTERM");
      const ended = await Promise.race([oldExited.then(() => true), Bun.sleep(3000).then(() => false)]);
      if (!ended) { old.kill("SIGKILL"); await oldExited; }
    } finally {
      this.restarting = false;
    }
    if ((this.state as State) === "exited") return false;
    // 起動し直している間に stop が呼ばれた（前のプロセスの終わりは数えないので、ここで終える）
    if (this.stopReason) { this.finish(null, this.stopReason); return false; }
    // /clear の後なら、今の会話（conversationId）を続ける。
    // 会話の行が読めれば --resume。読めなければ --session-id で起動し、すぐ終わったら --resume を試す。
    // /context だけを打った会話は jsonl に system の行しか無く、SDK（getSessionMessages、getSessionInfo）からは見えないが、
    // その id を --session-id にすると claude は起動しない。--resume なら起動する（2026-11-21 に実測）
    const conv = this.convId();
    const hasTalk = !!(await this.deps.transcript?.(conv, this.opts.cwd).catch(() => undefined))?.length;
    const tries: (string | undefined)[] = hasTalk ? [conv] : [undefined, conv];
    for (const resume of tries) {
      if ((this.state as State) === "exited" || this.stopReason) break;
      if (await this.spawnAndWait({ ...this.opts, prompt: undefined, fork: false, resume, model: c.model, permissionMode: c.permissionMode }, conv)) {
        this.opts.model = c.model;
        if (c.model) { this.model = c.model; this.modelAt = Date.now(); }
        this.permissionMode = c.permissionMode;
        this.push("config", { model: c.model, permissionMode: c.permissionMode });
        return true;
      }
    }
    if (this.stopReason && (this.state as State) !== "exited") this.finish(null, this.stopReason);
    return false;
  }
  // 1回起動して起動の印を待つ。出なければ、残っているプロセスを止めて false
  private async spawnAndWait(o: PtyStartOptions, sessionId: string): Promise<boolean> {
    this.restarting = true;
    // 印を作り直す。前のプロセスの hook（SessionEnd）は restarting の間は受けない
    this.ready = new Promise<void>((r) => { this.readyResolve = r; });
    this.inputReady = new Promise<void>((r) => { this.inputOnResolve = r; });
    this.inputOn = false;
    this.scanTail = "";
    let p: { gen: number; exited: Promise<void> };
    try { p = this.spawnProc(o, sessionId); } catch { this.restarting = false; return false; }
    this.probation = p.gen;
    this.restarting = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const ok = await Promise.race([this.ready.then(() => true), p.exited.then(() => false), new Promise<boolean>((r) => { timer = setTimeout(() => r(false), this.deps.readyTimeoutMs ?? 10_000); })]);
    clearTimeout(timer);
    if (!ok && !this.procDead) {
      this.gen++; // このプロセスの終わりも数えない
      clearTimeout(this.inputTimer);
      this.proc!.kill("SIGKILL");
      await p.exited;
    }
    this.probation = undefined;
    return ok;
  }

  summary(): SessionSummary {
    return {
      id: this.id, kind: this.kind, capabilities: this.capabilities, cwd: this.opts.cwd, state: this.state,
      startedAt: this.startedAt, lastActivityAt: this.lastActivityAt, model: this.model, permissionMode: this.permissionMode,
      exitReason: this.exitReason, pid: this.proc?.pid, title: this.opts.name, parent: this.parent,
      ...(this.conversationId ? { conversationId: this.conversationId } : {}),
      ...(this.deps.account ? { account: this.deps.account } : {}), ...(this.deps.accountEmail ? { accountEmail: this.deps.accountEmail } : {}),
    };
  }
  setParent(parent: string) { this.parent = parent; }
  // claude が起動した印（最初の hook。ふつうは SessionStart）を待つ。出れば true。先に終わったか、timeoutMs を過ぎたら false。
  // 引き継ぎ（succeed）は、これが true になってから前任を止める
  async started(timeoutMs: number): Promise<boolean> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const ok = await Promise.race([this.ready.then(() => true), new Promise<boolean>((r) => { timer = setTimeout(() => r(false), timeoutMs); })]);
    clearTimeout(timer);
    return ok && this.state !== "exited";
  }

  // 文は貼り付け（bracketed paste）で入れて Enter を押す。改行を含んでも1つの文になる（2026-11-12 に実機で確認）。
  // 承認画面が出ている間に Enter を押すと選択肢を選んでしまうので断る。起動の直後は SessionStart と入力の受け付けの両方を待つ。
  // SessionStart も待つのは、信頼の確認の画面（入力は受け付けるが hooks は止まっている）で Enter を押して信頼に答えないため
  async send(text: string) {
    if (this.state === "exited") throw new ExitedError(this.exitReason);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const ok = await Promise.race([Promise.all([this.ready, this.inputReady]).then(() => true), new Promise<boolean>((r) => { timer = setTimeout(() => r(false), this.deps.readyTimeoutMs ?? 10_000); })]);
    clearTimeout(timer);
    if ((this.state as State) === "exited") throw new ExitedError(this.exitReason);
    if (!ok) throw new BusyError("claude has not started yet; if the terminal shows a trust prompt, answer it there first");
    if (this.waiting.size) throw new BusyError("session is waiting for a permission answer; answer it first");
    this.proc!.write(`\x1b[200~${text}\x1b[201~`);
    await Bun.sleep(this.deps.pasteDelayMs ?? 150);
    this.proc!.write("\r");
    this.lastActivityAt = Date.now();
    return { delivered: "pty" as const };
  }
  // 組み込みコマンドを from 行を付けずに貼る（#64）。待ち方と断り方は send と同じ。
  // 出力は jsonl の <local-command-stdout> の行から、node と同じく合成の assistant の文と result にして流す
  async command(text: string, from: string) {
    const name = text.slice(1).split(/\s/, 1)[0]!.toLowerCase();
    if (PERSISTING_COMMANDS.has(name)) throw new CommandRefusedError("persists", `/${name} on an interactive claude is saved to the user's settings for every session; it is not sent`);
    this.push("command", { text, from });
    const r = await this.send(text);
    void this.chaseLocal();
    return r;
  }
  private localSeen = 0;   // 流した組み込みコマンドの出力の数
  private results = 0;     // 流した result の数
  // 出力の行が出るまで読み直す。出ないまま終わったら、待つ側（read_messages、Claude Town）が止まらないよう空の result を出す。
  // 出力が jsonl の system の行に書かれるコマンド（/context など）は、SDK の getSessionMessages が中身を返さないので読めない（2026-11-21 に実測）。
  // /compact の間（PreCompact から PostCompact まで、state が running）は出さない。PostCompact がもう一度読む
  private async chaseLocal() {
    const n = this.localSeen;
    const r = this.results;
    for (const ms of this.deps.localDelaysMs ?? LOCAL_DELAYS_MS) {
      await Bun.sleep(ms);
      if (this.state === "exited" || this.localSeen > n || this.results > r) return;
      await this.syncTranscript();
    }
    if (this.state === "idle" && this.localSeen === n && this.results === r) {
      this.push("result", { type: "result", subtype: "success", is_error: false, result: "", note: "no command output in the transcript; it may be shown only in the terminal" });
    }
  }
  events(): AsyncIterable<RawEvent> { return this.out; }
  pending(): PendingPermission[] { return [...this.waiting.values()].map((w) => w.p); }

  async answer(requestId: string, a: PermissionAnswer) {
    const w = this.waiting.get(requestId);
    if (!w) throw new NotFoundError(`no pending permission: ${requestId}`);
    this.waiting.delete(requestId);
    // NodeDriver と同じく、allow で入力の差し替えが無ければ元の入力を返す（AskUserQuestion と ExitPlanMode は updatedInput が要る）
    const decision = a.behavior === "allow"
      ? { behavior: "allow", updatedInput: a.updatedInput ?? w.p.input, ...(a.updatedPermissions ? { updatedPermissions: a.updatedPermissions } : {}) }
      : { behavior: "deny", message: a.message };
    w.resolve({ hookSpecificOutput: { hookEventName: "PermissionRequest", decision } });
    this.push("permission_answered", { requestId, behavior: a.behavior });
    if (!this.waiting.size && this.state === "waiting_permission") this.state = "running";
  }
  // Esc で今のターンを止める。止まっても hooks は来ないので、少し待って状態を照らし合わせる
  async interrupt() {
    if (this.state === "exited") throw new ExitedError(this.exitReason);
    this.proc!.write("\x1b");
    this.scheduleReconcile();
  }
  async stop(reason?: string) {
    if (this.state === "exited" || !this.proc) return;
    this.stopReason ??= reason;
    this.proc.kill("SIGTERM");
    const killed = await Promise.race([this.exitedP!.then(() => true), Bun.sleep(3000).then(() => false)]);
    if (!killed) { this.proc.kill("SIGKILL"); await this.exitedP; }
  }

  // --- 端末の口 ---
  get size() { return { cols: this.cols, rows: this.rows }; }
  // このプロセスの印。バイト位置はプロセスごとに0から数える
  readonly epoch = Date.now();
  // 画面のキー入力。そのまま書く。Esc や数字や Enter は端末の承認画面への答えかもしれないので、後で照らし合わせる。
  // claude が入力を読み始める前の分は溜めておき、読み始めたら順に流す（起動の直後に打った Enter が捨てられないように）
  write(data: Uint8Array) {
    if (this.state === "exited") throw new ExitedError(this.exitReason);
    if (this.inputOn) this.proc!.write(data);
    else this.early.push(new Uint8Array(data));
    this.lastActivityAt = Date.now();
    if (this.waiting.size || this.state === "running") this.scheduleReconcile();
  }
  // 大きさは最後に呼んだ画面に合わせる。付いている画面全部に知らせる
  resize(cols: number, rows: number) {
    if (this.state === "exited") throw new ExitedError(this.exitReason);
    if (cols === this.cols && rows === this.rows) return;
    this.flushOut(); // size より前の出力を先に送る
    this.cols = cols; this.rows = rows;
    this.proc!.resize(cols, rows);
    this.screen.resize(cols, rows);
    this.broadcast({ type: "size", cols, rows, epoch: this.epoch });
  }
  // after がまだ覚えている範囲なら続きのバイト列だけを data で流す。そうでなければ、ヘッドレスの端末の今の画面を replay で1回流す。
  // replay の offset はスナップショットを取った時点のバイト位置で、それより後の出力は data で続く。終わったセッションは replay と exit だけ
  // バイト位置はプロセスごとに0から数えるので、同じ id を resume した後の位置と混ざらないよう、epoch（このプロセスの印）が合うときだけ after を受ける
  // 返り値の close は購読をすぐ外す（読み手が切れたとき。次の出力を待たずに画面の数から外す）
  attach(after?: number, epoch?: number): AsyncIterable<TermFrame> & { close(): void } {
    // まだ送っていない出力を今いる画面に送ってから、新しい画面を足す。新しい画面には at までが replay か head で届く
    this.flushOut();
    const q = new AsyncQueue<TermFrame>();
    const sub: Sub = { q, bytes: 0 };
    const size: TermFrame = { type: "size", cols: this.cols, rows: this.rows, epoch: this.epoch };
    const resume = after !== undefined && (epoch === undefined || epoch === this.epoch) && after >= this.bufStart && after <= this.end;
    const at = this.end;
    // スナップショットの依頼と購読を同じ同期の区間で行う。at までの出力はスナップショットに入り、後の出力は q に来る
    const snap = resume ? undefined : this.screen.snapshot().catch(() => undefined);
    const head: TermFrame[] = resume ? this.tail(after!).map((u, i, a) => ({ type: "data" as const, b64: b64(u), offset: after! + a.slice(0, i + 1).reduce((n, x) => n + x.length, 0) })) : [];
    const exited = this.state === "exited";
    const ending: TermFrame | undefined = exited ? { type: "exit", code: this.exitCode, reason: this.exitReason ?? "" } : undefined;
    if (exited) q.close();
    else { this.subs.add(sub); this.lastViewAt = Date.now(); q.onClose = () => { this.subs.delete(sub); this.lastViewAt = Date.now(); }; }
    const rawReplay = () => this.tail(this.bufStart).map((u, i, a) => ({ type: "replay" as const, b64: b64(u), offset: this.bufStart + a.slice(0, i + 1).reduce((n, x) => n + x.length, 0) }));
    const gen = (async function* () {
      try {
      yield size;
      if (snap) {
        const text = await snap;
        // スナップショットが取れなければ、覚えている末尾のバイト列で代える
        if (text !== undefined) yield { type: "replay", b64: Buffer.from(text, "utf8").toString("base64"), offset: at } as TermFrame;
        else yield* rawReplay();
      }
      yield* head;
      // 読み出した分だけ溜めた量を戻す。読まない画面は SUB_LIMIT で切る
      for await (const f of q) { if (f.type === "data") sub.bytes -= f.b64.length; yield f; }
      if (ending) yield ending;
      } finally { q.close(); } // 途中で読むのをやめても購読を残さない
    })();
    return Object.assign(gen, { close: () => q.close() });
  }
  // 覚えている範囲を from から切り出し、64KB ごとに分ける
  private tail(from: number): Uint8Array[] {
    let pos = this.bufStart;
    const parts: Uint8Array[] = [];
    for (const c of this.chunks) {
      const s = pos, e = pos + c.length;
      pos = e;
      if (e <= from) continue;
      parts.push(s < from ? c.subarray(from - s) : c);
    }
    const kept = concat(parts);
    const out: Uint8Array[] = [];
    for (let i = 0; i < kept.length; i += REPLAY_CHUNK) out.push(kept.subarray(i, i + REPLAY_CHUNK));
    return out;
  }

  // 手が空いた子を止める仕組み（src/sessions/idle-stop.ts）のための口
  viewers() { return this.subs.size; }
  idleSince() { return this.lastViewAt; }
  // claude 本体がまだ待機中か。`claude agents --json` で busy か承認待ちなら false。引けなければ hooks の state を信じる
  async confirmIdle(): Promise<boolean> {
    if (this.state !== "idle" || !this.proc) return false;
    if (!this.deps.agentInfo) return true;
    const a = await this.deps.agentInfo(this.proc.pid).catch(() => undefined);
    return !a || a.status === undefined || a.status === "idle";
  }

  // --- hooks の受け口。api が token を確かめてから呼ぶ。返り値は hook の応答の JSON（無ければ空の 200） ---
  async hook(body: Record<string, unknown>): Promise<unknown> {
    if (this.state === "exited" || this.restarting) return undefined;
    this.lastActivityAt = Date.now();
    if (typeof body.permission_mode === "string") this.permissionMode = body.permission_mode;
    // SessionStart の model は startup と compact のときだけ来る（resume のときは無い。2026-11-21 に実測）
    if (typeof body.model === "string" && body.model) { this.model = body.model; this.modelAt = Date.now(); }
    // どの hook が来ても、claude は動いている
    this.readyResolve();
    switch (body.hook_event_name) {
      case "SessionStart":
        // /clear の後は新しい会話の id で来る（2026-11-21 に実測）。ccn の id はそのままにし、会話はこの id から読む
        if (body.source === "clear" && typeof body.session_id === "string" && body.session_id) {
          this.conversationId = body.session_id === this.id ? undefined : body.session_id;
          // -p の子と同じく、会話が替わったことと、コマンドが終わったことを流す（/clear は出力の行を書かない）
          this.push("conversation_reset", { type: "conversation_reset", conversationId: body.session_id });
          if (this.state === "idle") this.push("result", { type: "result", subtype: "success", is_error: false, result: "" });
        }
        return undefined;
      case "PreCompact":
        // 人や command の口が打った /compact（manual）の間は動いている。自動の圧縮はターンの途中なので触らない
        if (body.trigger === "manual" && this.state === "idle") this.state = "running";
        return undefined;
      case "PostCompact":
        if (body.trigger === "manual" && this.state === "running" && !this.waiting.size) this.state = "idle";
        void this.chaseLocal();
        return undefined;
      case "UserPromptSubmit":
        // 新しい文が入った。前のターンの承認待ちは残っていても答えようがない
        this.dropPending("superseded");
        this.state = "running";
        this.turnSeen = true;
        this.turnTexts = [];
        this.push("user", { type: "user", message: { role: "user", content: String(body.prompt ?? "") } });
        return undefined;
      case "PreToolUse": {
        // 道具を使い始めた。tool_use の行はもう書かれているので、hook は待たせずに裏で読む
        if (!this.waiting.size) this.state = "running";
        this.turnSeen = true;
        void this.chase("use", body);
        return undefined;
      }
      case "PermissionRequest":
        // 承認を待つ間も、道具の前に書いた文が見えるように先に流す（承認の hook は待たせない）
        void this.syncTranscript();
        return await this.onPermission(body);
      case "PostToolUse":
      case "PostToolUseFailure": {
        // 端末で答えた承認は hook の要求が切れないので、同じ道具と入力の実行が終わったら片付ける
        for (const [id, w] of this.waiting) if (w.p.toolName === body.tool_name && sameInput(w.p.input, body.tool_input)) this.drop(id, w, "answered in terminal");
        if (!this.waiting.size) this.state = "running";
        this.turnSeen = true; // Stop の hook がターンを続けさせた後も、ターンの途中にいる
        // 会話の行が読めなければ、hook の道具の名前と入力で補う。読めたら、結果の行が書かれるまで裏で読み直す
        if (!(await this.syncTranscript())) this.push("assistant", { type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", name: body.tool_name, input: body.tool_input ?? {} }] } });
        else void this.chase("result", body);
        return undefined;
      }
      case "Stop":
      case "StopFailure": {
        this.dropPending("turn ended");
        this.state = "idle";
        this.turnSeen = false;
        const text = typeof body.last_assistant_message === "string" ? body.last_assistant_message : "";
        const synced = await this.syncTranscript();
        // 最後の文の行がまだ書かれていなければ、hook の文で補う。後から同じ文の行が来ても流さない
        if (text && !this.turnTexts.includes(text)) {
          this.push("assistant", { type: "assistant", message: { role: "assistant", content: [{ type: "text", text }] } });
          if (synced) this.fallbackTexts.push(text);
        }
        this.turnTexts = [];
        this.push("result", { type: "result", subtype: body.hook_event_name === "Stop" ? "success" : "error_during_execution", is_error: body.hook_event_name !== "Stop", result: text });
        return undefined;
      }
      default:
        return undefined;
    }
  }

  private onPermission(body: Record<string, unknown>): Promise<unknown> {
    const requestId = crypto.randomUUID();
    const input = (body.tool_input && typeof body.tool_input === "object" ? body.tool_input : {}) as Record<string, unknown>;
    const p: PendingPermission = {
      requestId, toolName: String(body.tool_name ?? "?"), input, createdAt: Date.now(),
      description: typeof input.description === "string" ? input.description : typeof input.file_path === "string" ? input.file_path : undefined,
      suggestions: Array.isArray(body.permission_suggestions) ? body.permission_suggestions : undefined,
    };
    return new Promise((resolve) => {
      this.waiting.set(requestId, { p, resolve });
      this.state = "waiting_permission";
      this.push("permission_request", p);
    });
  }
  // 答えずに片付ける。hook には空で返す（claude は端末の承認画面に任せる）
  private drop(id: string, w: Waiting, reason: string) {
    this.waiting.delete(id);
    w.resolve(undefined);
    this.push("permission_answered", { requestId: id, behavior: "dismissed", reason });
  }
  private dropPending(reason: string) { for (const [id, w] of [...this.waiting]) this.drop(id, w, reason); }

  // 端末の Esc や承認画面への答えは hooks が来ないので、`claude agents --json` の状態に合わせる
  private scheduleReconcile() {
    if (!this.deps.agentInfo || this.reconcileTimer) return;
    this.reconcileTimer = setTimeout(() => { this.reconcileTimer = undefined; void this.reconcile(); }, this.deps.reconcileDelayMs ?? 1500);
  }
  async reconcile() {
    if (this.state === "exited" || !this.proc || !this.deps.agentInfo) return;
    const a = await this.deps.agentInfo(this.proc.pid).catch(() => undefined);
    if (!a || (this.state as State) === "exited") return;
    const asking = a.status === "waiting" && /permission/i.test(a.waitingFor ?? "");
    if (this.waiting.size && !asking) {
      this.dropPending("answered in terminal");
      this.state = a.status === "busy" ? "running" : "idle";
    }
    if (this.state === "running" && this.turnSeen && a.status === "idle") {
      this.state = "idle";
      this.turnSeen = false;
      this.push("result", { type: "result", subtype: "interrupted", is_error: true, result: "" });
    }
  }

  private markInputOn() {
    if (this.inputOn) return;
    this.inputOn = true;
    clearTimeout(this.inputTimer);
    this.inputOnResolve();
    const early = this.early;
    this.early = [];
    if (this.state !== "exited") for (const u of early) this.proc!.write(u);
  }

  private onData(u: Uint8Array) {
    const c = new Uint8Array(u); // 呼び出し元のバッファを使い回されても壊れないように写す
    if (!this.inputOn) {
      // 列が出力の切れ目をまたいでも見つけられるよう、前の出力の末尾を足して探す
      const t = this.scanTail + Buffer.from(c.buffer, c.byteOffset, c.byteLength).toString("latin1");
      if (t.includes(INPUT_ON)) this.markInputOn();
      else this.scanTail = t.slice(-(INPUT_ON.length - 1));
    }
    this.chunks.push(c);
    this.end += c.length;
    this.screen.write(c);
    let size = this.end - this.bufStart;
    const max = this.deps.maxBuffer ?? MAX_BUFFER;
    while (size > max && this.chunks.length > 1) { const x = this.chunks.shift()!; this.bufStart += x.length; size -= x.length; }
    if (!this.subs.size) return; // 見ている画面が無ければ送るものも無い。後から繋いだ画面は replay か head で受け取る
    this.unsent.push(c);
    if (this.flushTimer) return;
    const wait = this.lastFlushAt + DATA_GAP_MS - Date.now();
    if (wait <= 0) this.flushOut();
    else this.flushTimer = setTimeout(() => this.flushOut(), wait);
  }
  // まだ送っていない出力を1つの data にして、付いている画面全部に送る。offset は this.end（送る出力の末尾）
  private flushOut() {
    clearTimeout(this.flushTimer);
    this.flushTimer = undefined;
    if (!this.unsent.length) return;
    const u = concat(this.unsent);
    this.unsent = [];
    this.lastFlushAt = Date.now();
    this.broadcast({ type: "data", b64: b64(u), offset: this.end });
  }
  private broadcast(f: TermFrame) {
    for (const s of this.subs) {
      if (f.type === "data") {
        s.bytes += f.b64.length;
        if (s.bytes > SUB_LIMIT) { s.q.close(); continue; }
      }
      s.q.push(f);
    }
  }
  private push(type: string, data: unknown) { if (type === "result") this.results++; this.out.push({ at: Date.now(), type, data }); }

  // 道具の tool_use か tool_result の行が出るまで、CHASE_DELAYS_MS の間隔で読み直す。サブエージェントの道具（agent_id がある）は、行が本体の会話に入らないので追わない
  private async chase(kind: "use" | "result", body: Record<string, unknown>) {
    const id = typeof body.tool_use_id === "string" ? body.tool_use_id : "";
    if (!id || body.agent_id || !this.deps.transcript) { if (kind === "use") await this.syncTranscript(); return; }
    const key = `${kind}:${id}`;
    if (this.seenTools.has(key)) return;
    this.wanted.add(key);
    try {
      if (kind === "use") await this.syncTranscript();
      for (const ms of this.deps.chaseDelaysMs ?? CHASE_DELAYS_MS) {
        if (!this.wanted.has(key) || this.state === "exited") return;
        await Bun.sleep(ms);
        await this.syncTranscript();
      }
    } finally { this.wanted.delete(key); }
  }
  // 流した道具の行の印。追い始める前に流れていた行を、もう一度待たないため。古いものから捨てる
  private seenTools = new Set<string>();
  private markTool(key: string) {
    this.wanted.delete(key);
    this.seenTools.add(key);
    if (this.seenTools.size > 512) this.seenTools.delete(this.seenTools.values().next().value!);
  }

  // 会話の行を読み、まだ流していない行を順に流す。assistant の行は全部、user の行は道具の結果だけ（打った文は UserPromptSubmit で流す）。
  // このプロセスの起動より前の行（resume や fork で引き継いだ会話）は流さない。
  // 読んでいる間に呼ばれたら、今の読み込みの後にもう1回だけ読む（その間の呼び出しは全部その1回を待つ）
  // 読めたら true。transcript が無いか、読めなければ false（呼び手が hooks の値で補う）
  private syncTranscript(): Promise<boolean> {
    if (!this.deps.transcript) return Promise.resolve(false);
    if (!this.syncRun) return this.startSync();
    this.syncNext ??= this.syncRun.then(() => { this.syncNext = undefined; return this.startSync(); });
    return this.syncNext;
  }
  private startSync(): Promise<boolean> {
    const run = this.readTranscript();
    this.syncRun = run;
    void run.finally(() => { if (this.syncRun === run) this.syncRun = undefined; });
    return run;
  }
  private async readTranscript(): Promise<boolean> {
    const read = this.deps.transcript!;
    if (this.state === "exited") return false;
    const lines = await read(this.convId(), this.opts.cwd).catch(() => undefined);
    if (!lines) return false;
    for (const l of lines) {
      if (!l.uuid || this.seenLines.has(l.uuid)) continue;
      this.seenLines.add(l.uuid);
      const at = l.timestamp ? Date.parse(l.timestamp) : NaN;
      if (Number.isFinite(at) && at < this.startedAt) continue;
      const content = (l.message as { content?: unknown } | undefined)?.content;
      const blocks = Array.isArray(content) ? (content as { type?: string; text?: string; id?: string; tool_use_id?: string }[]) : [];
      if (l.type === "assistant") {
        // 応答の行のモデルを今のモデルにする。遅れて読んだ古い行（起動し直す前のターンの行など）では戻さない。<synthetic> は組み込みコマンドの出力
        const m = (l.message as { model?: unknown } | undefined)?.model;
        if (typeof m === "string" && m && !m.startsWith("<") && Number.isFinite(at) && at > this.modelAt) { this.model = m; this.modelAt = at; }
        const text = blocks.length === 1 && blocks[0]!.type === "text" ? blocks[0]!.text ?? "" : undefined;
        if (text !== undefined) {
          const i = this.fallbackTexts.indexOf(text);
          if (i >= 0) { this.fallbackTexts.splice(i, 1); continue; } // Stop の hook の文で補った分
          this.turnTexts.push(text);
        }
        for (const b of blocks) if (b.type === "tool_use" && b.id) this.markTool(`use:${b.id}`);
        this.push("assistant", l);
      } else if (l.type === "user" && typeof content === "string" && /^<local-command-std(out|err)>/.test(content)) {
        // 組み込みコマンドの出力。-p の子と同じく、合成の assistant の文と result にする
        const text = content.replace(/^<local-command-std(?:out|err)>/, "").replace(/<\/local-command-std(?:out|err)>\s*$/, "").replace(ANSI, "").trim();
        this.localSeen++;
        this.push("assistant", { type: "assistant", message: { role: "assistant", model: "<synthetic>", content: [{ type: "text", text }] } });
        this.push("result", { type: "result", subtype: "success", is_error: false, result: text });
      } else if (l.type === "user" && blocks.some((b) => b.type === "tool_result")) {
        for (const b of blocks) if (b.type === "tool_result" && b.tool_use_id) this.markTool(`result:${b.tool_use_id}`);
        this.push("user", l);
      }
    }
    return true;
  }
  private finish(code: number | null, reason: string) {
    if (this.state === "exited") return;
    this.flushOut(); // exit より前の出力を先に送る
    clearTimeout(this.reconcileTimer);
    clearTimeout(this.inputTimer);
    this.early = [];
    this.readyResolve();
    this.inputOnResolve();
    this.dropPending(reason);
    this.state = "exited";
    this.exitCode = code;
    this.exitReason = reason;
    for (const s of this.subs) { s.q.push({ type: "exit", code, reason }); s.q.close(); }
    this.subs.clear();
    this.push("exited", { reason, code });
    this.out.close();
    if (this.dir) void rm(this.dir, { recursive: true, force: true }).catch(() => {});
  }
}

function concat(parts: Uint8Array[]): Uint8Array {
  if (parts.length === 1) return parts[0]!;
  const n = parts.reduce((a, p) => a + p.length, 0);
  const u = new Uint8Array(n);
  let o = 0;
  for (const p of parts) { u.set(p, o); o += p.length; }
  return u;
}

// 本物の PTY。Bun 1.3 の Bun.Terminal。
// terminal には作った Terminal ではなく options を渡す。作った Terminal を渡すと、子は setsid されず PTY を制御端末に持たないので、
// resize しても SIGWINCH が届かず、claude が古い桁数のまま描く。options なら子は自分のセッションの頭になり、PTY が制御端末になる。
// SIGWINCH はカーネルが前面のプロセスグループ（claude と、claude が前面で動かす子）に送る。
// この違いは公式の説明に無く、Bun 1.3.11 と 1.3.14（macOS）、1.4.4（Linux）で実測した。test/engine/pty-spawn.test.ts が確かめる
export const bunPtySpawn: PtySpawn = (argv, o) => {
  const p = Bun.spawn(argv, { terminal: { cols: o.cols, rows: o.rows, data: (_t, d) => o.onData(d) }, cwd: o.cwd, env: o.env });
  const term = p.terminal!;
  return {
    pid: p.pid,
    write: (d) => { term.write(d); },
    resize: (c, r) => term.resize(c, r),
    kill: (s) => p.kill(s),
    exited: p.exited.then((c) => { try { term.close(); } catch {} return c; }),
  };
};
