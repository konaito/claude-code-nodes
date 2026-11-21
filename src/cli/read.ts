// 返事を読む。events 能力があれば SSE を after から result まで（切れたら最後の seq からつなぎ直す）、無ければ messages をポーリングする。出すのは assistant の文とツールの名前
import type { SessionSummary } from "../sessions/types";
import { describePending } from "../sessions/pending";
import { api, CliError, type Client } from "./client";

export type ReadResult = { code: 0 | 2 | 3 | 4; seq: number };
export type ReadDeps = {
  fetchFn?: typeof fetch;
  pollMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>; // つなぎ直す前の待ち（試験で差し替える）
  retryMs?: number;                      // つなぎ直しの最初の間隔。失敗が続くと倍にし、RETRY_MAX_MS で止める
};
const RETRY_MS = 500;
const RETRY_MAX_MS = 5000;
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
    // 中身（Bash の command、ファイルの道具の file_path）を出す。値の改行は逃がしてあるので1行に収まる
    out(`[permission] ${describePending(m)} requestId=${String(m.requestId)}`);
  } else if (m.type === "command") {
    // from 行を付けずに送った組み込みコマンド（#64）。誰が送ったかを出す
    out(`[command] ${String((m as { text?: string }).text ?? "")} (from ${String((m as { from?: string }).from ?? "?")})`);
  } else if (m.type === "exited") {
    out(`[exited] ${String((m as { reason?: string }).reason ?? "")}`.trim());
  }
}

// SSE を1回つないで読む。終わり方を返す。terminal は result、permission_request、exited のどれかを見た、
// closed はストリームが正常に閉じた、retry は繋がらないか途中で切れた（瞬断）、gone はセッションが台帳に無い（404）、deadline は締め切り
type Attempt = { end: "terminal" | "closed" | "retry" | "gone" | "deadline"; got: boolean; why?: string };

async function streamOnce(c: Client, s: SessionSummary, st: { seq: number; saw?: "result" | "permission" | "exited" }, deadline: number, out: Out, fetchFn: typeof fetch, now: () => number): Promise<Attempt> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), Math.max(0, deadline - now()));
  let got = false;
  try {
    const r = await fetchFn(`${c.base}/api/sessions/${s.id}/events?after=${st.seq}`, { headers: c.headers, signal: ctl.signal });
    if (!r.ok || !r.body) {
      await r.body?.cancel().catch(() => {});
      if (r.status === 404) return { end: "gone", got };
      // 401、403（Access）と 409（events 能力が無い）はつなぎ直しても変わらない
      if (r.status === 401 || r.status === 403 || r.status === 409) throw new CliError(1, `${c.peer} GET /api/sessions/${s.id}/events → ${r.status}`);
      return { end: "retry", got, why: `events ${r.status}` };
    }
    const reader = r.body.getReader();
    const dec = new TextDecoder();
    let buf = ""; // 途中で切れたら、最後の枠の切れ端はここで捨てる
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) return { end: "closed", got };
        buf += dec.decode(value, { stream: true });
        let i: number;
        while ((i = buf.indexOf("\n\n")) >= 0) {
          const frame = buf.slice(0, i); buf = buf.slice(i + 2);
          if (!frame || frame.startsWith(":")) continue;
          got = true;
          let event = "", data: unknown, id: number | undefined;
          for (const line of frame.split("\n")) {
            if (line.startsWith("id: ")) id = Number(line.slice(4)) || undefined;
            else if (line.startsWith("event: ")) event = line.slice(7);
            else if (line.startsWith("data: ")) { try { data = JSON.parse(line.slice(6)); } catch { data = line.slice(6); } }
          }
          if (id !== undefined) st.seq = id;
          if (event === "gap") {
            const g = (data ?? {}) as { from?: number; to?: number };
            out(`[gap] seq ${String(g.from)}..${String(g.to)} はノードの上限を超えて捨てられ、読めなかった`);
            continue;
          }
          const m = inner({ type: event, data });
          if (!m.type) m.type = event; // permission_request や exited の data には type が無い
          render(m, out);
          if (event === "result") { st.saw = "result"; return { end: "terminal", got }; }
          if (event === "permission_request") { st.saw = "permission"; return { end: "terminal", got }; }
          if (event === "exited") { st.saw = "exited"; return { end: "terminal", got }; }
        }
      }
    } finally { await reader.cancel().catch(() => {}); }
  } catch (e) {
    if (e instanceof CliError) throw e;
    if (e instanceof Error && e.name === "AbortError") return { end: "deadline", got };
    return { end: "retry", got, why: e instanceof Error ? e.message : String(e) }; // ネットワークの例外、途中で切れた本文
  } finally { clearTimeout(timer); }
}

export async function readUntilResult(c: Client, s: SessionSummary, after: number, waitSec: number, out: Out, deps: ReadDeps = {}): Promise<ReadResult> {
  const fetchFn = deps.fetchFn ?? fetch;
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const deadline = now() + waitSec * 1000;
  let seq = after;
  let saw: "result" | "permission" | "exited" | undefined;
  if (s.capabilities.events) {
    // 締め切りまで、最後に読んだ seq から SSE をつなぎ直す。トンネルの瞬断（502、530、途中で切れた本文）で抜けない
    const st: { seq: number; saw?: typeof saw } = { seq };
    const base = deps.retryMs ?? RETRY_MS;
    let backoff = base;
    let lastWhy: string | undefined;
    while (now() < deadline) {
      const a = await streamOnce(c, s, st, deadline, out, fetchFn, now);
      if (a.end === "terminal" || a.end === "gone" || a.end === "deadline") break;
      if (a.end === "closed") {
        // 正常に閉じたのは、ノードが台帳の購読を閉じたとき（セッションの終わりか入れ替え）。終わっていれば待たない
        const d = await api<Detail>(c, "GET", `/api/sessions/${s.id}`, undefined, fetchFn).catch(() => undefined);
        if (d?.state === "exited") { st.saw = "exited"; break; }
      }
      // 切れた理由は変わったときだけ出す（同じ理由で数百行にしない）
      if (a.end === "retry" && a.why !== lastWhy) { out(`[reconnect] ${a.why ?? ""} seq=${st.seq}`.replace(/\s+/g, " ")); lastWhy = a.why; }
      if (a.got) backoff = base; // 何か読めたら間隔を戻す
      const wait = Math.min(backoff, Math.max(0, deadline - now()));
      if (wait <= 0) break;
      await sleep(wait);
      backoff = Math.min(backoff * 2, RETRY_MAX_MS);
    }
    seq = st.seq;
    saw = st.saw;
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
