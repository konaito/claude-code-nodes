// PTY で対話モードの claude を動かす PtyDriver。人が画面（xterm.js など）で同じ端末を見て打てるセッション。
// 出力をヘッドレスの端末（src/engine/screen.ts）に流し、繋いだ画面に今の画面を replay で渡す。続きから読むために、出力の末尾（既定 2MB）も覚える。承認、ターンの終わり、状態は、--settings で注入した hooks（http）から受ける。
// 画面の文字は読まない。hooks が届かない操作（端末での Esc など）は `claude agents --json` の状態で照らし合わせる
import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Driver, RawEvent } from "./driver";
import { BusyError, ExitedError, NotFoundError } from "./driver";
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
  claudePath?: string;
  agentInfo?: (pid: number) => Promise<AgentInfo | undefined>; // 端末で答えた承認や Esc の後に状態を照らし合わせる
  maxBuffer?: number;       // 覚える末尾のバイト数。既定 2MB
  env?: Record<string, string | undefined>;
  reconcileDelayMs?: number;
  tmp?: string;             // 設定ファイルを置く場所。既定は OS の tmp
  pasteDelayMs?: number;
  readyTimeoutMs?: number;  // send が claude の起動（SessionStart と入力の受け付け）を待つ上限。既定 10 秒（中継の応答待ち15秒より短くする）
  inputTimeoutMs?: number;  // 起動から入力の受け付け（ESC[?2004h）を待つ上限。過ぎたら溜めた入力を流す。既定 10 秒
};

const MAX_BUFFER = 2 * 1024 * 1024;
// claude が入力を読み始めると出す、bracketed paste を有効にする列
const INPUT_ON = "\x1b[?2004h";
const REPLAY_CHUNK = 64 * 1024;
// 画面に送る data の間隔の下限。間に届いた出力は1つの data にまとめる。17ms で1秒あたり60回以下になる（#25）。
// 前の data から間が空いていれば、待たずにすぐ送る（打った文字の表示を遅らせない）
const DATA_GAP_MS = 17;
const SUB_LIMIT = 8 * 1024 * 1024; // 1つの画面に溜めてよいバイト数。超えたら切り、画面は after で繋ぎ直す
const HOOK_EVENTS = ["UserPromptSubmit", "PermissionRequest", "PostToolUse", "PostToolUseFailure", "Stop", "StopFailure", "Notification"] as const;
const PERMISSION_HOOK_TIMEOUT_S = 7 * 24 * 3600; // 承認は人が答えるまで待つ。切れると端末の承認画面だけが残る
const EVENT_HOOK_TIMEOUT_S = 10;

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
  private unsent: Uint8Array[] = []; // まだ画面に送っていない出力。末尾は this.end
  private flushTimer?: ReturnType<typeof setTimeout>;
  private lastFlushAt = 0;
  // 今のターンの UserPromptSubmit を見た。見る前（起動の引数の文がまだ届いていない間）に agents が idle と言っても、ターンは終わっていない
  private turnSeen = false;

  private constructor(private opts: PtyStartOptions, private deps: PtyDeps) {
    this.cols = opts.cols ?? 120;
    this.rows = opts.rows ?? 40;
    this.permissionMode = opts.permissionMode;
    this.screen = new Screen(this.cols, this.rows);
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
    if (opts.prompt) d.state = "running";
    try {
      d.proc = deps.spawn(ptyArgv(deps.claudePath ?? "claude", d.id, file, opts), {
        cwd: opts.cwd, env: childEnv(deps.env ?? process.env), cols: d.cols, rows: d.rows, onData: (u) => d.onData(u),
      });
    } catch (e) {
      await rm(d.dir, { recursive: true, force: true }).catch(() => {});
      throw e;
    }
    // 版が変わって ESC[?2004h が出なくなっても止まらないよう、上限を過ぎたら受け付けたものとして流す
    d.inputTimer = setTimeout(() => d.markInputOn(), deps.inputTimeoutMs ?? 10_000);
    d.exitedP = d.proc.exited.then((code) => d.finish(code, code === 0 || code === null ? "ended" : `exit ${code}`), (e) => d.finish(null, String(e)));
    return d;
  }

  summary(): SessionSummary {
    return {
      id: this.id, kind: this.kind, capabilities: this.capabilities, cwd: this.opts.cwd, state: this.state,
      startedAt: this.startedAt, lastActivityAt: this.lastActivityAt, model: this.opts.model, permissionMode: this.permissionMode,
      exitReason: this.exitReason, pid: this.proc?.pid, title: this.opts.name, parent: this.deps.caller,
    };
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
  async stop() {
    if (this.state === "exited" || !this.proc) return;
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
  attach(after?: number, epoch?: number): AsyncIterable<TermFrame> {
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
    else { this.subs.add(sub); q.onClose = () => this.subs.delete(sub); }
    const rawReplay = () => this.tail(this.bufStart).map((u, i, a) => ({ type: "replay" as const, b64: b64(u), offset: this.bufStart + a.slice(0, i + 1).reduce((n, x) => n + x.length, 0) }));
    return (async function* () {
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

  // --- hooks の受け口。api が token を確かめてから呼ぶ。返り値は hook の応答の JSON（無ければ空の 200） ---
  async hook(body: Record<string, unknown>): Promise<unknown> {
    if (this.state === "exited") return undefined;
    this.lastActivityAt = Date.now();
    if (typeof body.permission_mode === "string") this.permissionMode = body.permission_mode;
    // どの hook が来ても、claude は動いている
    this.readyResolve();
    switch (body.hook_event_name) {
      case "SessionStart":
        return undefined;
      case "UserPromptSubmit":
        // 新しい文が入った。前のターンの承認待ちは残っていても答えようがない
        this.dropPending("superseded");
        this.state = "running";
        this.turnSeen = true;
        this.push("user", { type: "user", message: { role: "user", content: String(body.prompt ?? "") } });
        return undefined;
      case "PermissionRequest": return await this.onPermission(body);
      case "PostToolUse":
      case "PostToolUseFailure": {
        // 端末で答えた承認は hook の要求が切れないので、同じ道具と入力の実行が終わったら片付ける
        for (const [id, w] of this.waiting) if (w.p.toolName === body.tool_name && sameInput(w.p.input, body.tool_input)) this.drop(id, w, "answered in terminal");
        if (!this.waiting.size) this.state = "running";
        this.turnSeen = true; // Stop の hook がターンを続けさせた後も、ターンの途中にいる
        this.push("assistant", { type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", name: body.tool_name, input: body.tool_input ?? {} }] } });
        return undefined;
      }
      case "Stop":
      case "StopFailure": {
        this.dropPending("turn ended");
        this.state = "idle";
        this.turnSeen = false;
        const text = typeof body.last_assistant_message === "string" ? body.last_assistant_message : "";
        if (text) this.push("assistant", { type: "assistant", message: { role: "assistant", content: [{ type: "text", text }] } });
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
  private push(type: string, data: unknown) { this.out.push({ at: Date.now(), type, data }); }
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
