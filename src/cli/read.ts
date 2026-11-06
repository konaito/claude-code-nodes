// 返事を読む。events 能力があれば SSE を after から result まで、無ければ messages をポーリングする。出すのは assistant の文とツールの名前
import type { SessionSummary } from "../sessions/types";
import { api, request, type Client } from "./client";

export type ReadResult = { code: 0 | 2 | 3 | 4; seq: number };
export type ReadDeps = { fetchFn?: typeof fetch; pollMs?: number; now?: () => number };
type Out = (line: string) => void;
type Detail = SessionSummary & { pending: unknown[] };

// 生のイベント（{seq,type,data}）か履歴の行（{type,message}）のどちらでも中身を取り出す
function inner(ev: unknown): { type?: string; message?: { content?: unknown }; [k: string]: unknown } {
  const e = ev as Record<string, unknown>;
  const d = e.data;
  return (d && typeof d === "object" ? d : e) as ReturnType<typeof inner>;
}
export function render(m: ReturnType<typeof inner>, out: Out) {
  if (m.type === "assistant") {
    const content = m.message?.content;
    if (typeof content === "string") { out(content); return; }
    for (const b of Array.isArray(content) ? (content as Array<Record<string, unknown>>) : []) {
      if (b.type === "text" && typeof b.text === "string") out(b.text);
      else if (b.type === "tool_use") {
        const input = (b.input ?? {}) as Record<string, unknown>;
        const desc = typeof input.description === "string" ? input.description : typeof input.file_path === "string" ? input.file_path : typeof input.command === "string" ? input.command : "";
        out(`[tool] ${String(b.name)} ${desc}`.trim());
      }
    }
  } else if (m.type === "permission_request") {
    out(`[permission] ${String(m.toolName)} ${String(m.description ?? "")} requestId=${String(m.requestId)}`.replace(/\s+/g, " "));
  } else if (m.type === "exited") {
    out(`[exited] ${String((m as { reason?: string }).reason ?? "")}`.trim());
  }
}

export async function readUntilResult(c: Client, s: SessionSummary, after: number, waitSec: number, out: Out, deps: ReadDeps = {}): Promise<ReadResult> {
  const fetchFn = deps.fetchFn ?? fetch;
  const now = deps.now ?? Date.now;
  const deadline = now() + waitSec * 1000;
  let seq = after;
  let saw: "result" | "permission" | "exited" | undefined;
  if (s.capabilities.events) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), Math.max(0, deadline - now()));
    try {
      const r = await fetchFn(`${c.base}/api/sessions/${s.id}/events?after=${after}`, { headers: c.headers, signal: ctl.signal });
      if (!r.ok || !r.body) throw new Error(`events ${r.status}`);
      const reader = r.body.getReader();
      const dec = new TextDecoder();
      let buf = "";
      outer: while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let i: number;
        while ((i = buf.indexOf("\n\n")) >= 0) {
          const frame = buf.slice(0, i); buf = buf.slice(i + 2);
          if (!frame || frame.startsWith(":")) continue;
          let event = "", data: unknown;
          for (const line of frame.split("\n")) {
            if (line.startsWith("id: ")) seq = Number(line.slice(4)) || seq;
            else if (line.startsWith("event: ")) event = line.slice(7);
            else if (line.startsWith("data: ")) { try { data = JSON.parse(line.slice(6)); } catch { data = line.slice(6); } }
          }
          const m = inner({ type: event, data });
          if (!m.type) m.type = event; // permission_request や exited の data には type が無い
          render(m, out);
          if (event === "result") { saw = "result"; break outer; }
          if (event === "permission_request") { saw = "permission"; break outer; }
          if (event === "exited") { saw = "exited"; break outer; }
        }
      }
      await reader.cancel().catch(() => {});
    } catch (e) {
      if (!(e instanceof Error && e.name === "AbortError")) throw e;
    } finally { clearTimeout(timer); }
  } else {
    const pollMs = deps.pollMs ?? 3000;
    let gotAssistant = false;
    while (true) {
      const page = await api<{ messages: unknown[]; next?: number }>(c, "GET", `/api/sessions/${s.id}/messages?after=${seq}`, undefined, fetchFn);
      for (const m of page.messages) { const x = inner(m); render(x, out); if (x.type === "assistant") gotAssistant = true; }
      if (page.next !== undefined) seq = page.next;
      if (gotAssistant) {
        const d = await api<Detail>(c, "GET", `/api/sessions/${s.id}`, undefined, fetchFn);
        if (d.state === "idle") { saw = "result"; break; }
        if (d.state === "exited") { saw = "exited"; break; }
      }
      if (now() >= deadline) break;
      await new Promise((r) => setTimeout(r, Math.min(pollMs, Math.max(0, deadline - now()))));
    }
  }
  const d = await api<Detail>(c, "GET", `/api/sessions/${s.id}`, undefined, fetchFn).catch(() => undefined);
  const state = d?.state ?? "unknown";
  const pending = d?.pending?.length ?? 0;
  out(`state=${state} pending=${pending} seq=${seq}`);
  const code: ReadResult["code"] = saw === "permission" || pending > 0 ? 3 : saw === "result" ? 0 : saw === "exited" || state === "exited" ? 4 : 2;
  return { code, seq };
}
