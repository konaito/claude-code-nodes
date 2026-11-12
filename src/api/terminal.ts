// 端末の口と、PTY のセッションの hooks の受け口。端末の口は能力（capabilities.terminal）を持つセッションだけが受ける
import { timingSafeEqual } from "node:crypto";
import type { Driver } from "../engine/driver";
import { CapabilityError } from "../engine/driver";
import type { PtyDriver } from "../engine/pty-driver";
import type { SessionStore } from "../sessions/store";
import { isLoopbackHost } from "../identity/identity";
import { PTY_HOOK_PATH, PTY_HOOK_TOKEN_HEADER } from "../names";
import { HttpError, json } from "./errors";
import { sse } from "./sse";

type Terminal = Pick<PtyDriver, "attach" | "write" | "resize" | "hook" | "token">;
const asTerminal = (d: Driver): Terminal | undefined => (d.capabilities.terminal && "attach" in d ? (d as unknown as Terminal) : undefined);

function must(store: SessionStore, id: string): Terminal {
  const d = store.get(id);
  if (!d) throw new HttpError(404, { error: "no live session" });
  const t = asTerminal(d);
  if (!t) throw new CapabilityError("terminal");
  return t;
}

// GET /api/sessions/:id/terminal。最初に size、続きの指定が無ければ replay（末尾）、以後 data。終われば exit で閉じる。
// id はバイト位置で、Last-Event-ID か ?after= で続きから読める
export function terminalStream(store: SessionStore, id: string, req: Request, url: URL): Response {
  const t = must(store, id);
  const raw = req.headers.get("last-event-id") ?? url.searchParams.get("after");
  const n = raw === null || raw === "" ? undefined : Number(raw);
  const after = n !== undefined && Number.isInteger(n) && n >= 0 ? n : undefined;
  const e = Number(url.searchParams.get("epoch") ?? "");
  const frames = t.attach(after, Number.isInteger(e) && e > 0 ? e : undefined);
  return sse((async function* () {
    for await (const f of frames) {
      if (f.type === "size") yield { event: "size", data: { cols: f.cols, rows: f.rows, epoch: f.epoch } };
      else if (f.type === "exit") yield { event: "exit", data: { code: f.code, reason: f.reason } };
      else yield { id: f.offset, event: f.type, data: { b64: f.b64 } };
    }
  })());
}

// POST /api/sessions/:id/terminal/input。{ data: base64 } をそのまま書く。{ text } は UTF-8 で書く
export async function terminalInput(store: SessionStore, id: string, req: Request) {
  const t = must(store, id);
  const b = (await req.json().catch(() => ({}))) as { data?: unknown; text?: unknown };
  let bytes: Uint8Array;
  if (typeof b.data === "string" && b.data) {
    if (!/^[A-Za-z0-9+/]*={0,2}$/.test(b.data)) throw new HttpError(400, { error: "data must be base64" });
    bytes = new Uint8Array(Buffer.from(b.data, "base64"));
  } else if (typeof b.text === "string" && b.text) bytes = new TextEncoder().encode(b.text);
  else throw new HttpError(400, { error: "data (base64) or text is required" });
  if (bytes.length > 1024 * 1024) throw new HttpError(413, { error: "input too large (max 1MB)" });
  t.write(bytes);
  return { ok: true, bytes: bytes.length };
}

// POST /api/sessions/:id/terminal/resize。後勝ち
export async function terminalResize(store: SessionStore, id: string, req: Request) {
  const t = must(store, id);
  const b = (await req.json().catch(() => ({}))) as { cols?: unknown; rows?: unknown };
  const ok = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v >= 10 && v <= 1000;
  if (!ok(b.cols) || !ok(b.rows)) throw new HttpError(400, { error: "cols and rows must be integers from 10 to 1000" });
  t.resize(b.cols, b.rows);
  return { ok: true, cols: b.cols, rows: b.rows };
}

export const isPtyHook = (path: string) => path.startsWith(PTY_HOOK_PATH + "/");

// POST /hooks/pty/:id。PTY の子の claude が hooks（http）で送ってくる。Access の呼び手は無いので、
// 同じ機械（loopback で、Cloudflare を通っていない）からの要求で、セッションごとの token が合うものだけを受ける
export async function ptyHook(store: SessionStore, req: Request, url: URL): Promise<Response> {
  if (req.method !== "POST") throw new HttpError(405, { error: "method not allowed" });
  if (!isLoopbackHost(req) || req.headers.get("cf-connecting-ip")) throw new HttpError(403, { error: "hooks are accepted only from this machine" });
  const id = decodeURIComponent(url.pathname.slice(PTY_HOOK_PATH.length + 1));
  const d = store.get(id);
  const t = d ? asTerminal(d) : undefined;
  const given = Buffer.from(req.headers.get(PTY_HOOK_TOKEN_HEADER) ?? "");
  const want = Buffer.from(t?.token ?? "");
  if (!t || given.length !== want.length || !timingSafeEqual(given, want)) throw new HttpError(403, { error: "bad hook token" });
  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const out = await t.hook(body);
  return out === undefined ? new Response(null, { status: 200 }) : json(out);
}
