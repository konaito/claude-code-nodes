// Cloudflare Access の JWT（Cf-Access-Jwt-Assertion）を呼び手に変える。人は email、ノードはサービストークンの common_name。
// 規則は仕様 2.1。email なら外から来た x-cc-from は捨て、ノード用サービストークンならそのまま受け取り、JWT 無しは同じ機械からだけ通す
import { AccessDenied, HeaderIdentity, type Caller, type Identity } from "./identity";

export type Jwks = { keys: (JsonWebKey & { kid: string })[] };
export type AccessDeps = {
  teamDomain: string;
  aud: string;
  fetchJwks?: () => Promise<Jwks>; // 既定は Access の公開鍵。1時間メモリに持ち、未知の kid で1回だけ取り直す
  now?: () => number;              // ミリ秒
  local?: Identity;                // JWT が無く、Cloudflare を通っていない要求の扱い。既定は HeaderIdentity
};

const JWKS_TTL_MS = 3600_000;
type Payload = { aud?: string | string[]; iss?: string; exp?: number; email?: string; common_name?: string };

const fromB64url = (s: string) => Uint8Array.from(Buffer.from(s, "base64url"));

export class AccessIdentity implements Identity {
  private keys?: { at: number; map: Map<string, CryptoKey> };
  private fetchJwks: () => Promise<Jwks>;
  private now: () => number;
  private local: Identity;

  constructor(private deps: AccessDeps) {
    this.fetchJwks = deps.fetchJwks ?? (async () => {
      const r = await fetch(`https://${deps.teamDomain}/cdn-cgi/access/certs`);
      if (!r.ok) throw new Error(`jwks ${r.status}`);
      return (await r.json()) as Jwks;
    });
    this.now = deps.now ?? Date.now;
    this.local = deps.local ?? new HeaderIdentity();
  }

  async callerOf(req: Request): Promise<Caller> {
    const token = tokenFrom(req);
    if (!token) {
      // Cloudflare を通った要求に JWT が無い。Access が覆っていないホスト名なので、local として扱わない
      if (req.headers.get("cf-connecting-ip")) throw new AccessDenied(401, "access token required");
      return this.local.callerOf(req);
    }
    const p = await this.verify(token);
    if (typeof p.email === "string" && p.email) return { id: p.email, kind: "user" };
    if (typeof p.common_name === "string" && p.common_name) {
      const from = req.headers.get("x-cc-from")?.trim();
      const via = req.headers.get("x-cc-via")?.trim();
      const c: Caller = { id: from || `agent:${p.common_name}`, kind: "node" };
      if (via) c.via = via;
      return c;
    }
    throw new AccessDenied(403, "access: no identity in token");
  }

  private async verify(token: string): Promise<Payload> {
    const [h, p, sig] = token.split(".");
    if (!h || !p || !sig) throw new AccessDenied(403, "access: malformed token");
    let header: { alg?: string; kid?: string };
    let payload: Payload;
    try {
      header = JSON.parse(new TextDecoder().decode(fromB64url(h)));
      payload = JSON.parse(new TextDecoder().decode(fromB64url(p)));
    } catch { throw new AccessDenied(403, "access: malformed token"); }
    if (header.alg !== "RS256" || !header.kid) throw new AccessDenied(403, "access: bad alg");
    const key = (await this.keyFor(header.kid)) ?? (await this.keyFor(header.kid, true));
    if (!key) throw new AccessDenied(403, "access: unknown kid");
    const ok = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, fromB64url(sig), new TextEncoder().encode(`${h}.${p}`));
    if (!ok) throw new AccessDenied(403, "access: bad signature");
    const aud = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
    if (!aud.includes(this.deps.aud)) throw new AccessDenied(403, "access: bad aud");
    if (payload.iss !== `https://${this.deps.teamDomain}`) throw new AccessDenied(403, "access: bad iss");
    if (typeof payload.exp !== "number" || payload.exp * 1000 < this.now()) throw new AccessDenied(403, "access: expired");
    return payload;
  }

  private async keyFor(kid: string, fresh = false): Promise<CryptoKey | undefined> {
    if (fresh || !this.keys || this.now() - this.keys.at > JWKS_TTL_MS) {
      const { keys } = await this.fetchJwks();
      const map = new Map<string, CryptoKey>();
      for (const k of keys) {
        const { kid: id, ...jwk } = k;
        map.set(id, await crypto.subtle.importKey("jwk", jwk, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]));
      }
      this.keys = { at: this.now(), map };
    }
    return this.keys.map.get(kid);
  }
}

function tokenFrom(req: Request): string | null {
  const header = req.headers.get("cf-access-jwt-assertion");
  if (header) return header;
  const m = req.headers.get("cookie")?.match(/(?:^|;\s*)CF_Authorization=([^;]+)/);
  return m?.[1] ?? null;
}
