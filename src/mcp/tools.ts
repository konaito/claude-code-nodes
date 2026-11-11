// MCP のツール。中身は HTTP の API（api）を呼ぶだけで、手元と中継の振り分け、能力の検査、from 行はすべて API 側にある。
// ツールは呼び手（Identity が決めたもの）を閉じ込めて作る。as で名乗れるのは、HTTP で HEADER_FROM を信じてもらえる呼び手（ノード用サービストークンと同じ機械）だけ
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { Caller } from "../identity/identity";
import { formatAgent } from "../identity/agent-name";
import { render } from "../cli/read";
import type { ApiCall } from "./server";
import type { PendingPermission, SessionSummary } from "../sessions/types";

export type ToolClock = { now: () => number; sleep: (ms: number) => Promise<void>; pollMs: number };
type Ctx = { nodeName: string; caller: Caller; api: ApiCall; clock: ToolClock };
type Detail = SessionSummary & { pending: PendingPermission[]; cursor?: number };
type Peer = { name: string; url: string; status: string; self?: boolean };

// 待つツールの上限。Cloudflare は応答の無いまま 125 秒で 524 を返し、MCP の TypeScript クライアントの既定の要求の締め切りは 60 秒なので、その手前で返す
export const MAX_WAIT_SECONDS = 50;
export const DEFAULT_WAIT_SECONDS = 30;
// 1回の結果の文字数の既定。Claude Code は 10,000 トークンで警告を出し、25,000 トークンで切る
export const DEFAULT_MAX_CHARS = 20_000;
const LIST_LIMIT = 50;
const PAGE = 200; // 履歴の1ページ（engine/history.ts と同じ）

class ToolError extends Error {}
const ok = (v: unknown): CallToolResult => ({ content: [{ type: "text", text: typeof v === "string" ? v : JSON.stringify(v, null, 1) }] });
const fail = (msg: string): CallToolResult => ({ content: [{ type: "text", text: msg }], isError: true });

// 2xx でなければ、API の error と hint をそのまま返す（モデルが直して呼び直せるように）
async function call<T>(c: Ctx, method: string, peer: string | undefined, path: string, body?: unknown): Promise<T> {
  const r = await c.api(c.caller, method, peer, path, body);
  if (r.status >= 200 && r.status < 300) return r.body as T;
  const b = (r.body ?? {}) as { error?: string; hint?: string };
  throw new ToolError(`${peer ?? c.nodeName} ${method} ${path} → ${r.status} ${b.error ?? ""}${b.hint ? ` (hint: ${b.hint})` : ""}`.trim());
}
const run = (fn: () => Promise<unknown>) => async (): Promise<CallToolResult> => {
  try { return ok(await fn()); } catch (e) { return fail(e instanceof Error ? e.message : String(e)); }
};

const FULL_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// session は sessionId か先頭8文字以上。<peer>/<id> の形なら peer も取る（ccn の CLI と同じ書き方）
async function resolve(c: Ctx, peerArg: string | undefined, session: string): Promise<{ peer: string; id: string }> {
  const i = session.indexOf("/");
  const peer = (i > 0 ? session.slice(0, i) : peerArg) || c.nodeName;
  const id = i > 0 ? session.slice(i + 1) : session;
  if (FULL_ID.test(id)) return { peer, id };
  if (id.length < 8) throw new ToolError(`session "${id}" is too short. Give the full sessionId or its first 8+ characters`);
  const list = await call<SessionSummary[]>(c, "GET", peer, "/api/sessions");
  const hits = list.filter((s) => s.id === id || s.id.startsWith(id));
  if (hits.length === 1) return { peer, id: hits[0]!.id };
  if (!hits.length) throw new ToolError(`no session matches "${id}" on ${peer}. Use list_sessions`);
  throw new ToolError(`"${id}" matches ${hits.length} sessions on ${peer}: ${hits.map((s) => s.id).join(", ")}`);
}

// as で名乗る。email の呼び手（Access の人のログイン）は HTTP と同じく名乗りを上書きできない
function callerWith(c: Ctx, as?: string, asSession?: string): { ctx: Ctx; note?: string } {
  if (!as && !asSession) return { ctx: c };
  if (c.caller.kind === "user") return { ctx: c, note: `as is ignored: callers signed in by email keep their email (${c.caller.id})` };
  const caller: Caller = { ...c.caller, id: formatAgent(c.nodeName, asSession, as) };
  return { ctx: { ...c, caller } };
}

const peerArg = z.string().optional().describe("Node name from list_peers. Omit for the node serving this MCP endpoint");
const sessionArg = z.string().describe("sessionId, its first 8+ characters, or <peer>/<sessionId>");
const asArg = z.string().optional().describe("Role to sign as, e.g. lead. The child sees `from agent:<node>/<as_session first 8>/<role> via <node>` and its parent field becomes that name. Ignored for callers signed in by email");
const asSessionArg = z.string().optional().describe("Your own Claude Code session id (e.g. $CLAUDE_CODE_SESSION_ID). Put into the agent name so list_sessions(parent=...) finds only your children");
const compact = (s: SessionSummary, peer: string) => ({ peer, id: s.id, kind: s.kind, state: s.state, cwd: s.cwd, parent: s.parent, title: s.title, permissionMode: s.permissionMode, lastActivityAt: s.lastActivityAt });

export function registerTools(server: McpServer, base: Omit<Ctx, never>) {
  server.registerTool("list_peers", {
    title: "List nodes",
    description: "List the ccn nodes (machines) this node knows, with healthy/down status. Use the name as `peer` in other tools.",
    inputSchema: {},
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, run(() => call<Peer[]>(base, "GET", undefined, "/api/peers")));

  server.registerTool("list_sessions", {
    title: "List sessions",
    description: `List Claude Code sessions on one node, newest first. By default only sessions that are not exited (node children and terminal sessions); set include_exited for past ones. Returns at most ${LIST_LIMIT} unless limit is given.`,
    inputSchema: {
      peer: peerArg,
      parent: z.string().optional().describe("Only children whose first message came from this caller, e.g. the `parent` returned by create_session"),
      include_exited: z.boolean().optional().describe("Also list exited and past sessions"),
      limit: z.number().int().min(1).max(500).optional(),
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, async (a) => run(async () => {
    const q = a.parent ? `?parent=${encodeURIComponent(a.parent)}` : "";
    const list = await call<SessionSummary[]>(base, "GET", a.peer, `/api/sessions${q}`);
    const peer = a.peer || base.nodeName;
    const shown = list.filter((s) => a.include_exited || s.state !== "exited").sort((x, y) => y.lastActivityAt - x.lastActivityAt);
    const limit = a.limit ?? LIST_LIMIT;
    return { sessions: shown.slice(0, limit).map((s) => compact(s, peer)), total: shown.length, truncated: shown.length > limit };
  })());

  server.registerTool("get_session", {
    title: "Get session",
    description: "Show one session: state (running, waiting_permission, idle, exited), capabilities, permission mode, parent, pending permission requests, and cursor (the seq to pass as `after` to read only newer messages).",
    inputSchema: { peer: peerArg, session: sessionArg },
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, async (a) => run(async () => {
    const t = await resolve(base, a.peer, a.session);
    return { peer: t.peer, ...(await call<Detail>(base, "GET", t.peer, `/api/sessions/${t.id}`)) };
  })());

  server.registerTool("create_session", {
    title: "Create session",
    description: "Start a new Claude Code session (a child) on a node, in a directory under that node's allowed roots, with a first message. The message arrives with a from line naming you. Returns the session id, the parent name it records, and cursor 0 for read_messages. Omit permission_mode to use that machine's Claude Code default (check permissionMode with get_session). default asks before every tool (answer with answer_permission); bypassPermissions runs unattended, as the ccn CLI does.",
    inputSchema: {
      peer: peerArg,
      cwd: z.string().describe("Absolute directory on that node"),
      prompt: z.string().min(1).describe("First message. Make it self-contained: goal, directory, done criteria, what not to touch, and ask it to write the result as text"),
      permission_mode: z.enum(["default", "acceptEdits", "bypassPermissions", "plan", "dontAsk", "auto"]).optional(),
      model: z.string().optional(),
      resume: z.string().optional().describe("Session id to continue instead of starting fresh"),
      fork: z.boolean().optional().describe("With resume, branch into a new session id"),
      as: asArg,
      as_session: asSessionArg,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  }, async (a) => {
    const { ctx, note } = callerWith(base, a.as, a.as_session);
    return run(async () => {
      const body: Record<string, unknown> = { cwd: a.cwd, prompt: a.prompt };
      if (a.permission_mode) body.permissionMode = a.permission_mode;
      if (a.model) body.model = a.model;
      if (a.resume) body.resume = a.resume;
      if (a.fork) body.fork = true;
      const r = await call<{ id: string }>(ctx, "POST", a.peer, "/api/sessions", body);
      return { peer: a.peer || base.nodeName, id: r.id, parent: ctx.caller.id, cursor: 0, ...(note ? { note } : {}) };
    })();
  });

  server.registerTool("send_message", {
    title: "Send message",
    description: "Send one message to a session. Node children receive it as the next user turn; terminal sessions (started by a person) receive it as a message from another session. Returns cursor: the seq before this message. Pass it as `after` to read_messages to get the reply. Send one message per turn and wait for the reply before sending more.",
    inputSchema: { peer: peerArg, session: sessionArg, text: z.string().min(1), as: asArg, as_session: asSessionArg },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  }, async (a) => {
    const { ctx, note } = callerWith(base, a.as, a.as_session);
    return run(async () => {
      const t = await resolve(ctx, a.peer, a.session);
      const before = await call<Detail>(ctx, "GET", t.peer, `/api/sessions/${t.id}`);
      const r = await call<{ delivered: string }>(ctx, "POST", t.peer, `/api/sessions/${t.id}/messages`, { text: a.text });
      return { peer: t.peer, id: t.id, delivered: r.delivered, cursor: before.cursor ?? 0, from: ctx.caller.id, ...(note ? { note } : {}) };
    })();
  });

  server.registerTool("read_messages", {
    title: "Read messages",
    description: `Read a session's messages after a cursor and wait up to wait_seconds (max ${MAX_WAIT_SECONDS}, default ${DEFAULT_WAIT_SECONDS}) for the turn to end. Shows assistant text, tool names, permission requests and exit. Ends with stop: result (turn finished), permission (answer it with answer_permission), exited (resume with create_session resume=<id>), timeout (still working; call again with after=cursor), or truncated (output limit; call again with after=cursor).`,
    inputSchema: {
      peer: peerArg,
      session: sessionArg,
      after: z.number().int().min(0).optional().describe("Cursor from send_message, create_session or the previous read_messages. Default 0 (from the start)"),
      wait_seconds: z.number().min(0).max(MAX_WAIT_SECONDS).optional(),
      max_chars: z.number().int().min(1000).max(100_000).optional().describe(`Output limit. Default ${DEFAULT_MAX_CHARS}`),
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, async (a) => run(async () => {
    const t = await resolve(base, a.peer, a.session);
    const r = await readMessages(base, t.peer, t.id, a.after ?? 0, Math.min(a.wait_seconds ?? DEFAULT_WAIT_SECONDS, MAX_WAIT_SECONDS), a.max_chars ?? DEFAULT_MAX_CHARS);
    const pending = r.pending.map((p) => `[pending] requestId=${p.requestId} ${p.toolName} ${p.description ?? ""}`.trim());
    return [...r.lines, ...pending, `stop=${r.stop} state=${r.state} pending=${r.pending.length} cursor=${r.cursor} session=${t.peer}/${t.id}`].join("\n");
  })());

  server.registerTool("answer_permission", {
    title: "Answer permission",
    description: "Allow or deny a pending tool permission request of a node child (state waiting_permission). request_id may be omitted when exactly one is pending. Deny needs a message telling the child why. Terminal sessions cannot be answered.",
    inputSchema: {
      peer: peerArg,
      session: sessionArg,
      behavior: z.enum(["allow", "deny"]),
      request_id: z.string().optional(),
      message: z.string().optional().describe("Reason shown to the child when denying"),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async (a) => run(async () => {
    const t = await resolve(base, a.peer, a.session);
    let rid = a.request_id;
    if (!rid) {
      const d = await call<Detail>(base, "GET", t.peer, `/api/sessions/${t.id}`);
      if (d.pending.length !== 1) throw new ToolError(`${d.pending.length} requests are pending; give request_id (${d.pending.map((p) => p.requestId).join(", ") || "none"})`);
      rid = d.pending[0]!.requestId;
    }
    if (a.behavior === "deny" && !a.message?.trim()) throw new ToolError("deny needs a message");
    const body = a.behavior === "allow" ? { behavior: "allow" } : { behavior: "deny", message: a.message };
    await call(base, "POST", t.peer, `/api/sessions/${t.id}/permissions/${encodeURIComponent(rid)}`, body);
    return { ok: true, peer: t.peer, id: t.id, requestId: rid, behavior: a.behavior };
  })());

  server.registerTool("interrupt_session", {
    title: "Interrupt session",
    description: "Stop the current turn of a node child. The session stays alive and accepts the next message. Terminal sessions cannot be interrupted.",
    inputSchema: { peer: peerArg, session: sessionArg },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
  }, async (a) => run(async () => {
    const t = await resolve(base, a.peer, a.session);
    await call(base, "POST", t.peer, `/api/sessions/${t.id}/interrupt`);
    return { ok: true, peer: t.peer, id: t.id };
  })());

  server.registerTool("stop_session", {
    title: "Stop session",
    description: "End a node child's process. The conversation is kept and can be continued with create_session resume=<id>. Terminal sessions cannot be stopped.",
    inputSchema: { peer: peerArg, session: sessionArg },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
  }, async (a) => run(async () => {
    const t = await resolve(base, a.peer, a.session);
    await call(base, "DELETE", t.peer, `/api/sessions/${t.id}`);
    return { ok: true, peer: t.peer, id: t.id };
  })());
}

export type ReadOut = { lines: string[]; cursor: number; stop: "result" | "permission" | "exited" | "timeout" | "truncated"; state: string; pending: PendingPermission[] };

// messages?after= をたどって描き、ターンの終わり（result、権限待ち、終了）か締め切りか文字数の上限で返す。
// 生きているセッションのイベントは seq を持ち、履歴（端末と過去）は offset で数える（api/sessions.ts の cursor と同じ数え方）
export async function readMessages(c: Ctx, peer: string, id: string, after: number, waitSec: number, maxChars: number): Promise<ReadOut> {
  const deadline = c.clock.now() + waitSec * 1000;
  const lines: string[] = [];
  let chars = 0;
  let cursor = after;
  let gotAssistant = false;
  let stop: ReadOut["stop"] | undefined;
  let detail: Detail | undefined;
  while (!stop) {
    const page = await call<{ messages: unknown[]; next?: number }>(c, "GET", peer, `/api/sessions/${id}/messages?after=${cursor}`);
    const start = cursor;
    for (const [i, raw] of page.messages.entries()) {
      const ev = raw as { seq?: number; type?: string; data?: unknown };
      const live = typeof ev.seq === "number" && ev.data !== undefined;
      const m = (live && ev.data && typeof ev.data === "object" ? ev.data : raw) as Parameters<typeof render>[0];
      const type = live ? ev.type : m.type;
      if (live && !m.type) m.type = type; // permission_request や exited の data には type が無い
      const out: string[] = [];
      render(m, (s) => out.push(s));
      const size = out.reduce((n, s) => n + s.length + 1, 0);
      if (chars + size > maxChars) {
        if (lines.length) { stop = "truncated"; break; }
        out.splice(0, out.length, out.join("\n").slice(0, maxChars) + " …[cut]");
      }
      lines.push(...out);
      chars += size;
      cursor = live ? ev.seq! : start + i + 1;
      if (type === "assistant") gotAssistant = true;
      if (type === "result") { stop = "result"; break; }
      if (type === "permission_request") { stop = "permission"; break; }
      if (type === "exited") { stop = "exited"; break; }
    }
    if (stop) break;
    if (page.messages.length >= PAGE) continue; // 履歴の続きのページ
    detail = await call<Detail>(c, "GET", peer, `/api/sessions/${id}`);
    if (detail.pending.length) { stop = "permission"; break; }
    if (detail.state === "exited") { stop = "exited"; break; }
    // 端末のセッションは result を出さないので、返事が来たあと idle になったら終わりとみなす（CLI の read と同じ）
    if (gotAssistant && detail.state === "idle") { stop = "result"; break; }
    const left = deadline - c.clock.now();
    if (left <= 0) { stop = "timeout"; break; }
    await c.clock.sleep(Math.min(c.clock.pollMs, left));
    detail = undefined;
  }
  detail ??= await call<Detail>(c, "GET", peer, `/api/sessions/${id}`).catch(() => undefined);
  return { lines, cursor, stop, state: detail?.state ?? "unknown", pending: detail?.pending ?? [] };
}
