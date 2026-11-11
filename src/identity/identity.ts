// 呼び手を決める境界。プロトコルは HEADER_FROM と HEADER_VIA（names.ts）のヘッダだけを見る。誰がこのヘッダを置いてよいかはアプリケーション（AccessIdentity）が決める
import { HEADER_FROM, HEADER_VIA, LEGACY_HEADER_FROM, LEGACY_HEADER_VIA } from "../names";

export type CallerKind = "user" | "node" | "local"; // user は Access の email、node はノード用サービストークン、local は同じ機械
export type Caller = { id: string; via?: string; kind?: CallerKind }; // id は email か "agent:<名前>" か "local"
export interface Identity { callerOf(req: Request): Promise<Caller> } // 断るときは AccessDenied を投げる

export class AccessDenied extends Error {
  constructor(public status: 401 | 403, message: string) { super(message); this.name = "AccessDenied"; }
}

// JWT の無い要求を信じてよいのは、宛先が loopback のときだけ。DNS rebinding（evil.example → 127.0.0.1）を断る
const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]"]);
export function isLoopbackHost(req: Request): boolean {
  return LOOPBACK.has(new URL(req.url).hostname);
}

// 呼び手のヘッダを読む。新（HEADER_FROM）を先に見て、無ければ旧（LEGACY_HEADER_FROM）。まだ更新していないノードからの中継も読める
export function callerHeaders(req: Request): { from?: string; via?: string } {
  const pick = (a: string, b: string) => req.headers.get(a)?.trim() || req.headers.get(b)?.trim() || undefined;
  return { from: pick(HEADER_FROM, LEGACY_HEADER_FROM), via: pick(HEADER_VIA, LEGACY_HEADER_VIA) };
}

export class HeaderIdentity implements Identity {
  async callerOf(req: Request): Promise<Caller> {
    if (!isLoopbackHost(req)) throw new AccessDenied(401, "access token required");
    const { from: id, via } = callerHeaders(req);
    if (!id) return { id: "local", kind: "local" };
    return via ? { id, via, kind: "local" } : { id, kind: "local" };
  }
}
