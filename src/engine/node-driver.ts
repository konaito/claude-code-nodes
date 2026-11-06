// SDK を包む NodeDriver。query() に非同期の入力を渡し、権限要求を保留して API から答えられるようにする。完全制御のセッション
import type { query, Query, PermissionMode, PermissionResult, SDKUserMessage, SettingSource } from "@anthropic-ai/claude-agent-sdk";
import type { Driver, RawEvent } from "./driver";
import { ExitedError, NotFoundError } from "./driver";
export { ExitedError, NotFoundError } from "./driver";
import type { PendingPermission, PermissionAnswer, SessionSummary, State } from "../sessions/types";
import { AsyncQueue } from "../sessions/async-queue";

export type QueryFn = typeof query;
export type StartOptions = {
  cwd: string;
  prompt?: string;
  permissionMode?: PermissionMode;
  model?: string;
  resume?: string;
  fork?: boolean;
  settingSources?: SettingSource[];
  mcpServers?: Record<string, unknown>;
};
export type NodeDeps = { queryFn: QueryFn; nodeName: string; caller?: string; initTimeoutMs?: number; claudePath?: string };


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
  private q!: Query;
  private abort = new AbortController();
  private startedAt = Date.now();
  private lastActivityAt = Date.now();
  private model?: string;
  private permissionMode?: string;
  private exitReason?: string;
  private usage = { inputTokens: 0, outputTokens: 0, costUsd: 0 };
  private initResolve?: () => void;
  private initReject?: (e: Error) => void;

  private constructor(private opts: StartOptions, private deps: NodeDeps) {}

  static async start(opts: StartOptions, deps: NodeDeps): Promise<NodeDriver> {
    const d = new NodeDriver(opts, deps);
    if (opts.prompt) { d.enqueueUser(opts.prompt); d.state = "running"; }
    const init = new Promise<void>((resolve, reject) => { d.initResolve = resolve; d.initReject = reject; });
    init.catch(() => {}); // race の後に reject しても未処理にしない
    d.q = deps.queryFn({
      prompt: d.input,
      options: {
        cwd: opts.cwd,
        permissionMode: opts.permissionMode,
        // この層は呼び手を信じる設計なので、bypass を頼まれたら SDK の必須フラグも付ける
        allowDangerouslySkipPermissions: opts.permissionMode === "bypassPermissions" ? true : undefined,
        model: opts.model,
        resume: opts.resume,
        forkSession: opts.fork,
        settingSources: opts.settingSources ?? ["user", "project", "local"],
        includePartialMessages: true,
        mcpServers: opts.mcpServers as never,
        abortController: d.abort,
        // 同梱の実行ファイルではなく、ログイン済みの PATH の claude を使う（版を揃えるため）
        pathToClaudeCodeExecutable: deps.claudePath,
        canUseTool: (toolName, input, { signal, suggestions }) => d.onPermission(toolName, input, signal, suggestions),
      },
    });
    void d.pump();
    // init が来るまで待つ。resume で入力が無いと init が初回の文まで来ないことがあるので、そのときは resume の id で進める（実機で確かめる）
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<"timeout">((r) => { timer = setTimeout(() => r("timeout"), deps.initTimeoutMs ?? 15000); });
    const r = await Promise.race([init.then(() => "init" as const), timeout]);
    clearTimeout(timer);
    if (r === "timeout" && !d.id) {
      if (opts.resume) d.id = opts.resume;
      else { await d.stop(); throw new Error("claude did not report system/init"); }
    }
    return d;
  }

  summary(): SessionSummary {
    return {
      id: this.id, kind: this.kind, capabilities: this.capabilities, cwd: this.opts.cwd, state: this.state,
      startedAt: this.startedAt, lastActivityAt: this.lastActivityAt, model: this.model, permissionMode: this.permissionMode,
      usage: { ...this.usage }, exitReason: this.exitReason, parent: this.deps.caller,
    };
  }
  async send(text: string) {
    if (this.state === "exited") throw new ExitedError(this.exitReason);
    this.enqueueUser(text);
    this.state = this.waiting.size ? "waiting_permission" : "running";
    this.lastActivityAt = Date.now();
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
  async interrupt() { await this.q.interrupt(); }
  async setPermissionMode(mode: string) { await this.q.setPermissionMode(mode as PermissionMode); this.permissionMode = mode; }
  async stop() { this.input.close(); this.abort.abort(); this.finish("stopped"); }

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
