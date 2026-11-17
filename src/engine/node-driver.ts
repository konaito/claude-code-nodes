// SDK を包む NodeDriver。query() に非同期の入力を渡し、権限要求を保留して API から答えられるようにする。完全制御のセッション
import type { query, Query, PermissionMode, PermissionResult, SDKUserMessage, SettingSource } from "@anthropic-ai/claude-agent-sdk";
import type { Driver, RawEvent } from "./driver";
import { ExitedError, NotFoundError } from "./driver";
export { ExitedError, NotFoundError } from "./driver";
import type { PendingPermission, PermissionAnswer, SessionSummary, State } from "../sessions/types";
import { AsyncQueue } from "../sessions/async-queue";
import type { Prepared } from "./account";

export type QueryFn = typeof query;
export type StartOptions = {
  cwd: string;
  prompt?: string;
  permissionMode?: PermissionMode;
  model?: string;
  resume?: string;
  fork?: boolean;
  // 新規のときに先に決める id（SDK の sessionId）。これがあって prompt も resume も無ければ、1通目が来るまで claude を起動しない
  sessionId?: string;
  // resume でも1通目が来るまで claude を起動しない（teleport で取り込んだ会話を台帳に載せるとき）
  defer?: boolean;
  settingSources?: SettingSource[];
  // 追加の設定ファイル（CLI の --settings）。受け口のセッションだけが持つ（src/lobby/lobby.ts の lobbySettingsFor）
  settings?: string;
  mcpServers?: Record<string, unknown>;
};
export type NodeDeps = {
  queryFn: QueryFn; nodeName: string; caller?: string; initTimeoutMs?: number; claudePath?: string;
  // claude を起動する直前に呼ぶ。返した環境で起動する（アカウントの選択、src/engine/account.ts）。env が無ければ process.env のまま。
  // 返したアカウントは summary に載せる。遅延起動では1通目の send のときに呼ぶので、作ってから時間が空いても、その時点の使用率で選ぶ
  prepare?: (cwd: string) => Promise<Prepared | undefined>;
};


type Waiting = { p: PendingPermission; input: Record<string, unknown>; resolve: (r: PermissionResult) => void };

export class NodeDriver implements Driver {
  readonly kind = "node" as const;
  // 終了したら何もできないので、能力も全部 false になる
  get capabilities() { const on = this.state !== "exited"; return { send: on, permissions: on, interrupt: on, stop: on, events: on }; }
  id = "";
  private state: State = "idle";
  private input = new AsyncQueue<SDKUserMessage>();
  private out = new AsyncQueue<RawEvent>();
  private waiting = new Map<string, Waiting>();
  private q?: Query;
  private deferred = false; // 1通目を待っていて、まだ claude を起動していない
  private abort = new AbortController();
  private startedAt = Date.now();
  private lastActivityAt = Date.now();
  private model?: string;
  private permissionMode?: string;
  private exitReason?: string;
  private usage = { inputTokens: 0, outputTokens: 0, costUsd: 0 };
  private initResolve?: () => void;
  private initReject?: (e: Error) => void;
  private parent?: string;       // 立てた呼び手。引き継ぎで付け替わる（setParent）
  private account?: string;      // 起動のときに選んだアカウント。起動するまで無い
  private accountEmail?: string;

  private constructor(private opts: StartOptions, private deps: NodeDeps) { this.parent = deps.caller; }

  static async start(opts: StartOptions, deps: NodeDeps): Promise<NodeDriver> {
    const d = new NodeDriver(opts, deps);
    // 遅延起動。待っている claude は1体で約300MB（2026-11-11 実測）あり、画面の「新しく」は打たずに離れることがあるので、1通目まで起動しない。
    // id は sessionId で先に決まり、init と jsonl のファイル名も同じ id になる（同日に実機で確認）
    if (!opts.prompt && ((opts.sessionId && !opts.resume) || (opts.defer && opts.resume))) {
      d.id = opts.resume ?? opts.sessionId!;
      d.deferred = true;
      d.permissionMode = opts.permissionMode;
      d.model = opts.model;
      return d;
    }
    if (opts.prompt) { d.enqueueUser(opts.prompt); d.state = "running"; }
    d.launch();
    // init が来るまで待つ。resume で入力が無いと init が初回の文まで来ないことがあるので、そのときは resume の id で進める（実機で確かめる）
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<"timeout">((r) => { timer = setTimeout(() => r("timeout"), deps.initTimeoutMs ?? 15000); });
    const r = await Promise.race([d.init.then(() => "init" as const), timeout]);
    clearTimeout(timer);
    if (r === "timeout" && !d.id) {
      if (opts.resume) d.id = opts.resume;
      else { await d.stop(); throw new Error("claude did not report system/init"); }
    }
    return d;
  }

  private init!: Promise<void>;
  // claude を起動する。遅延起動では1通目の send から1回だけ呼ぶ
  private launch() {
    this.deferred = false;
    const opts = this.opts;
    this.init = new Promise<void>((resolve, reject) => { this.initResolve = resolve; this.initReject = reject; });
    this.init.catch(() => {}); // race の後に reject しても未処理にしない
    if (!this.deps.prepare) { this.run(undefined); return; }
    // 用意の間に止められたら起動しない。用意が落ちたら今まで通り（process.env）で起動する
    void this.deps.prepare(opts.cwd).catch(() => undefined).then((p) => {
      if (this.state === "exited") return;
      this.account = p?.account;
      this.accountEmail = p?.accountEmail;
      this.run(p?.env);
    });
  }
  private run(env: Record<string, string | undefined> | undefined) {
    const opts = this.opts;
    try {
      this.q = this.deps.queryFn({
        prompt: this.input,
        options: {
          cwd: opts.cwd,
          permissionMode: (this.permissionMode ?? opts.permissionMode) as PermissionMode | undefined,
          // この層は呼び手を信じる設計なので、bypass を頼まれたら SDK の必須フラグも付ける
          allowDangerouslySkipPermissions: (this.permissionMode ?? opts.permissionMode) === "bypassPermissions" ? true : undefined,
          model: opts.model,
          resume: opts.resume,
          forkSession: opts.fork,
          // sessionId は resume と一緒には渡せない（fork のときは別）。遅延起動の新規だけが持つ
          sessionId: opts.resume ? undefined : opts.sessionId,
          settingSources: opts.settingSources ?? ["user", "project", "local"],
          settings: opts.settings,
          includePartialMessages: true,
          mcpServers: opts.mcpServers as never,
          abortController: this.abort,
          // 同梱の実行ファイルではなく、ログイン済みの PATH の claude を使う（版を揃えるため）
          pathToClaudeCodeExecutable: this.deps.claudePath,
          // SDK の env は process.env を置き換える。prepare は process.env に足したものを返す
          ...(env ? { env } : {}),
          canUseTool: (toolName, input, { signal, suggestions }) => this.onPermission(toolName, input, signal, suggestions),
        },
      });
    } catch (e) {
      this.finish(e instanceof Error ? e.message : String(e));
      return;
    }
    void this.pump();
  }

  summary(): SessionSummary {
    return {
      id: this.id, kind: this.kind, capabilities: this.capabilities, cwd: this.opts.cwd, state: this.state,
      startedAt: this.startedAt, lastActivityAt: this.lastActivityAt, model: this.model, permissionMode: this.permissionMode,
      usage: { ...this.usage }, exitReason: this.exitReason, parent: this.parent,
      ...(this.deferred ? { awaitingFirst: true } : {}),
      ...(this.account ? { account: this.account } : {}), ...(this.accountEmail ? { accountEmail: this.accountEmail } : {}),
    };
  }
  setParent(parent: string) { this.parent = parent; }
  async send(text: string) {
    if (this.state === "exited") throw new ExitedError(this.exitReason);
    this.enqueueUser(text);
    this.state = this.waiting.size ? "waiting_permission" : "running";
    this.lastActivityAt = Date.now();
    if (this.deferred) this.launch();
    return { delivered: "stdin" as const };
  }
  events(): AsyncIterable<RawEvent> { return this.out; }
  pending(): PendingPermission[] { return [...this.waiting.values()].map((w) => w.p); }
  async answer(requestId: string, a: PermissionAnswer) {
    const w = this.waiting.get(requestId);
    if (!w) throw new NotFoundError(`no pending permission: ${requestId}`);
    this.waiting.delete(requestId);
    w.resolve(a.behavior === "allow"
      ? { behavior: "allow", updatedInput: a.updatedInput ?? w.input, updatedPermissions: a.updatedPermissions as never }
      : { behavior: "deny", message: a.message });
    this.out.push({ at: Date.now(), type: "permission_answered", data: { requestId, behavior: a.behavior } });
    this.afterAnswer();
  }
  // 起動前は止めるターンが無い。権限モードは起動のときに渡す
  async interrupt() { if (this.q) await this.q.interrupt(); }
  async setPermissionMode(mode: string) { if (this.q) await this.q.setPermissionMode(mode as PermissionMode); this.permissionMode = mode; }
  async stop(reason = "stopped") { this.input.close(); this.abort.abort(); this.finish(reason); }

  private enqueueUser(text: string) {
    this.input.push({ type: "user", message: { role: "user", content: text }, parent_tool_use_id: null } as SDKUserMessage);
  }
  private onPermission(toolName: string, input: Record<string, unknown>, signal: AbortSignal, suggestions: unknown): Promise<PermissionResult> {
    const requestId = crypto.randomUUID();
    const p: PendingPermission = {
      requestId, toolName, input, createdAt: Date.now(),
      description: typeof input.description === "string" ? input.description : typeof input.file_path === "string" ? input.file_path : undefined,
      suggestions: Array.isArray(suggestions) ? suggestions : undefined,
    };
    return new Promise<PermissionResult>((resolve) => {
      this.waiting.set(requestId, { p, input, resolve });
      this.state = "waiting_permission";
      this.out.push({ at: Date.now(), type: "permission_request", data: p });
      signal.addEventListener("abort", () => {
        if (this.waiting.delete(requestId)) { resolve({ behavior: "deny", message: "aborted" }); this.afterAnswer(); }
      }, { once: true });
    });
  }
  private afterAnswer() { if (!this.waiting.size && this.state === "waiting_permission") this.state = "running"; }
  private async pump() {
    if (!this.q) return;
    try {
      for await (const m of this.q) {
        this.lastActivityAt = Date.now();
        this.handle(m as Record<string, unknown>);
        this.out.push({ at: Date.now(), type: String((m as { type: string }).type), data: m });
      }
      this.finish("ended");
    } catch (e) {
      this.finish(e instanceof Error ? e.message : String(e));
    }
  }
  private handle(m: Record<string, unknown>) {
    if (m.type === "system" && m.subtype === "init") {
      if (!this.id) this.id = String(m.session_id);
      if (typeof m.model === "string") this.model = m.model;
      if (typeof m.permissionMode === "string") this.permissionMode = m.permissionMode;
      this.initResolve?.();
    } else if (m.type === "result") {
      const u = (m.usage ?? {}) as Record<string, number>;
      this.usage.inputTokens += u.input_tokens ?? 0;
      this.usage.outputTokens += u.output_tokens ?? 0;
      this.usage.costUsd += typeof m.total_cost_usd === "number" ? m.total_cost_usd : 0;
      this.state = this.waiting.size ? "waiting_permission" : "idle";
    } else if ((m.type === "assistant" || m.type === "stream_event") && !this.waiting.size) {
      this.state = "running";
    }
  }
  private finish(reason: string) {
    if (this.state === "exited") return;
    this.state = "exited";
    this.exitReason = reason;
    this.initReject?.(new Error(reason));
    for (const [id, w] of this.waiting) { this.waiting.delete(id); w.resolve({ behavior: "deny", message: reason }); }
    this.out.push({ at: Date.now(), type: "exited", data: { reason } });
    this.out.close();
    this.input.close();
  }
}
