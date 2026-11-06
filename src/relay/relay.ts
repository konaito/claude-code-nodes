// /n/:peer/api/... を相手のノードに中継する。相手にはノード用サービストークンで繋ぎ、元の呼び手を x-cc-from と x-cc-via で運ぶ（仕様 2.3）
import type { Caller } from "../identity/identity";
import type { Registry } from "../registry/registry";

export type RelayDeps = {
  registry: Registry;
  nodeName: string;
  serviceToken?: { clientId: string; clientSecret: string };
  fetchFn?: typeof fetch;
  timeoutMs?: number; // 最初の応答（ヘッダ）までの待ち。既定 15 秒。SSE は応答が返れば以後は待たない
};

export class UnknownPeerError extends Error { constructor(public peer: string) { super(`unknown peer: ${peer}`); this.name = "UnknownPeerError"; } }
export class PeerUnreachableError extends Error {
  constructor(public peer: string, cause: unknown) { super(`peer ${peer} unreachable: ${cause instanceof Error ? cause.message : String(cause)}`); this.name = "PeerUnreachableError"; }
}
export class RelayNotConfiguredError extends Error { constructor() { super("relay needs a service token"); this.name = "RelayNotConfiguredError"; } }

const COPY_REQ = ["content-type", "accept", "last-event-id"];
const COPY_RES = ["content-type", "cache-control"];

export class Relay {
  private fetchFn: typeof fetch;
  private timeoutMs: number;
  constructor(private deps: RelayDeps) {
    this.fetchFn = deps.fetchFn ?? fetch;
    this.timeoutMs = deps.timeoutMs ?? 15_000;
  }

  async forward(peer: string, rest: string, req: Request, caller: Caller): Promise<Response> {
    const token = this.deps.serviceToken;
    if (!token) throw new RelayNotConfiguredError();
    const target = (await this.deps.registry.peers()).find((p) => p.name === peer);
    if (!target) throw new UnknownPeerError(peer);
    const url = new URL(req.url);
    const headers = new Headers();
    for (const h of COPY_REQ) { const v = req.headers.get(h); if (v) headers.set(h, v); }
    headers.set("cf-access-client-id", token.clientId);
    headers.set("cf-access-client-secret", token.clientSecret);
    headers.set("x-cc-from", caller.id);
    headers.set("x-cc-via", caller.via ?? this.deps.nodeName);
    const hasBody = req.method !== "GET" && req.method !== "HEAD";
    const init: RequestInit & { duplex?: "half" } = { method: req.method, headers, redirect: "manual" };
    if (hasBody) { init.body = req.body; init.duplex = "half"; }
    let upstream: Response;
    try {
      upstream = await withTimeout(this.fetchFn(`${target.url}/${rest}${url.search}`, init), this.timeoutMs);
    } catch (e) {
      throw new PeerUnreachableError(peer, e);
    }
    // Cloudflare の縁が返す 5xx の HTML（530 はトンネル切れ、502 はノード切れ）は、相手に届かなかったものとして扱う
    if (upstream.status >= 500 && (upstream.headers.get("content-type") ?? "").includes("text/html")) {
      await upstream.body?.cancel().catch(() => {});
      throw new PeerUnreachableError(peer, `upstream ${upstream.status}`);
    }
    const out = new Headers();
    for (const h of COPY_RES) { const v = upstream.headers.get(h); if (v) out.set(h, v); }
    return new Response(upstream.body, { status: upstream.status, headers: out });
  }
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const t = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`no response within ${ms}ms`)), ms); });
  return Promise.race([p, t]).finally(() => clearTimeout(timer));
}
