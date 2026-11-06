// ノードを呼ぶ道具。手元のノードは 127.0.0.1 に無認証、相手のノードは https://<peer>.<domain> にサービストークンで。呼び手は x-cc-from で名乗る
import { nodeHost, type Config } from "../config";

export type Client = { peer: string; base: string; headers: Record<string, string> };
export class CliError extends Error { constructor(public code: number, msg: string) { super(msg); this.name = "CliError"; } }

const NAME_MAX = 64;
// 旧 inbox と同じ規則。<ノード>/<自分の sessionId の先頭8文字>/<役割>。子の画面や from 行から親をたどれる
export function agentName(nodeName: string, sessionId: string | undefined, role: string | undefined): string {
  const label = (role && role.trim() ? role : "parent").replace(/[^A-Za-z0-9._/-]/g, "-");
  const sid = sessionId && /^[0-9a-f]{8}/.test(sessionId) ? sessionId.slice(0, 8) : null;
  const head = sid ? `${nodeName}/${sid}/` : `${nodeName}/`;
  return head + label.slice(0, Math.max(1, NAME_MAX - head.length));
}

export function clientFor(cfg: Config, peer: string | undefined, role: string | undefined, env: Record<string, string | undefined>): Client {
  const from = `agent:${agentName(cfg.name, env.CLAUDE_CODE_SESSION_ID, role)}`;
  const headers: Record<string, string> = { "x-cc-from": from, "x-cc-via": cfg.name };
  if (!peer || peer === cfg.name) return { peer: cfg.name, base: `http://127.0.0.1:${cfg.port}`, headers };
  if (!cfg.zone && !cfg.domain) throw new CliError(1, "cc.json に zone も domain も無いので相手のノードを呼べない");
  if (!cfg.serviceToken) throw new CliError(1, "cc.json に serviceToken が無いので相手のノードを呼べない");
  headers["cf-access-client-id"] = cfg.serviceToken.clientId;
  headers["cf-access-client-secret"] = cfg.serviceToken.clientSecret;
  return { peer, base: `https://${nodeHost(peer, cfg)}`, headers };
}

export async function request(c: Client, method: string, path: string, body?: unknown, fetchFn: typeof fetch = fetch, extra: Record<string, string> = {}): Promise<Response> {
  const headers: Record<string, string> = { ...c.headers, ...extra };
  if (body !== undefined) headers["content-type"] = "application/json";
  try {
    return await fetchFn(`${c.base}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  } catch (e) {
    throw new CliError(1, `${c.peer} に繋がらない: ${e instanceof Error ? e.message : String(e)}`);
  }
}

export async function api<T = unknown>(c: Client, method: string, path: string, body?: unknown, fetchFn: typeof fetch = fetch): Promise<T> {
  const r = await request(c, method, path, body, fetchFn);
  const text = await r.text();
  let v: unknown;
  // JSON でない応答（Cloudflare の 530 のページなど）はタグを落として1行に縮める
  try { v = text ? JSON.parse(text) : undefined; } catch { v = { error: text.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim().slice(0, 60) }; }
  if (!r.ok) {
    const b = (v ?? {}) as { error?: string; hint?: string };
    throw new CliError(1, `${c.peer} ${method} ${path} → ${r.status} ${b.error ?? ""}${b.hint ? ` (hint: ${b.hint})` : ""}`.trim());
  }
  return v as T;
}
