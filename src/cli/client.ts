// ノードを呼ぶ道具。手元のノードは 127.0.0.1 に無認証、相手のノードは https://<nodeHost> にサービストークンで。呼び手は HEADER_FROM で名乗る
import { nodeHost, type Config } from "../config";
import { AGENT_PREFIX, formatAgent } from "../identity/agent-name";
import { CONFIG_FILE, HEADER_FROM, HEADER_VIA } from "../names";

export type Client = { peer: string; base: string; headers: Record<string, string> };
export class CliError extends Error { constructor(public code: number, msg: string) { super(msg); this.name = "CliError"; } }

// agent: を除いた名前。組み立ての規則は identity/agent-name.ts
export function agentName(nodeName: string, sessionId: string | undefined, role: string | undefined): string {
  return formatAgent(nodeName, sessionId, role).slice(AGENT_PREFIX.length);
}

export function clientFor(cfg: Config, peer: string | undefined, role: string | undefined, env: Record<string, string | undefined>): Client {
  const from = formatAgent(cfg.name, env.CLAUDE_CODE_SESSION_ID, role);
  const headers: Record<string, string> = { [HEADER_FROM]: from, [HEADER_VIA]: cfg.name };
  if (!peer || peer === cfg.name) return { peer: cfg.name, base: `http://127.0.0.1:${cfg.port}`, headers };
  if (!cfg.zone && !cfg.domain) throw new CliError(1, `${CONFIG_FILE} に zone も domain も無いので相手のノードを呼べない`);
  if (!cfg.serviceToken) throw new CliError(1, `${CONFIG_FILE} に serviceToken が無いので相手のノードを呼べない`);
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
