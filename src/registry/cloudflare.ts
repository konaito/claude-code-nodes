// Cloudflare のトンネル一覧を登録簿として読む。名前が TUNNEL_PREFIX か LEGACY_TUNNEL_PREFIX（names.ts）で始まるトンネルを全部ノードとみなす。許可リストは持たない。
// URL はトンネルの実名から作る（cc-x なら https://cc-x.<zone>）。同じ名前が新旧の両方にあれば1つにまとめる
import { RegistryError, type Peer, type PeerStatus, type Registry } from "./registry";
import { hostFor } from "../config";
import { LEGACY_TUNNEL_PREFIX, TUNNEL_PREFIX } from "../names";

export type CloudflareDeps = {
  accountId: string;
  apiToken: string;    // Cloudflare Tunnel Read
  zone: string;        // https://<トンネル名>.<zone> がノードの URL
  selfName: string;
  prefixes?: string[]; // 先にあるものを優先する。既定 [TUNNEL_PREFIX, LEGACY_TUNNEL_PREFIX]
  fetchFn?: typeof fetch;
  cacheMs?: number;    // 既定 10 秒
  now?: () => number;
};
type Tunnel = { id: string; name: string; status: PeerStatus };

export class CloudflareRegistry implements Registry {
  private cache?: { at: number; value: Promise<Peer[]> };
  private prefixes: string[];
  private fetchFn: typeof fetch;
  private cacheMs: number;
  private now: () => number;

  constructor(private deps: CloudflareDeps) {
    this.prefixes = deps.prefixes ?? [TUNNEL_PREFIX, LEGACY_TUNNEL_PREFIX];
    this.fetchFn = deps.fetchFn ?? fetch;
    this.cacheMs = deps.cacheMs ?? 10_000;
    this.now = deps.now ?? Date.now;
  }

  peers(): Promise<Peer[]> {
    if (this.cache && this.now() - this.cache.at < this.cacheMs) return this.cache.value;
    const value = this.load();
    this.cache = { at: this.now(), value };
    value.catch(() => { this.cache = undefined; }); // 失敗は次で取り直す
    return value;
  }

  private async load(): Promise<Peer[]> {
    const url = `https://api.cloudflare.com/client/v4/accounts/${this.deps.accountId}/cfd_tunnel?is_deleted=false&per_page=100`;
    const r = await this.fetchFn(url, { headers: { authorization: `Bearer ${this.deps.apiToken}` } });
    if (!r.ok) throw new RegistryError(502, `cloudflare tunnels ${r.status}`);
    const body = (await r.json()) as { result?: Tunnel[] };
    const byName = new Map<string, { peer: Peer; rank: number }>();
    for (const t of body.result ?? []) {
      const i = this.prefixes.findIndex((p) => t.name.startsWith(p));
      if (i < 0) continue;
      const prefix = this.prefixes[i]!;
      const name = t.name.slice(prefix.length);
      if (!name) continue;
      const peer: Peer = { name, url: `https://${hostFor(prefix, name, this.deps.zone)}`, status: t.status, self: name === this.deps.selfName };
      // 同じ名前なら healthy を先に、次に新しい頭を選ぶ
      const rank = (t.status === "healthy" ? 0 : 10) + i;
      const cur = byName.get(name);
      if (!cur || rank < cur.rank) byName.set(name, { peer, rank });
    }
    return [...byName.values()].map((v) => v.peer).sort((a, b) => a.name.localeCompare(b.name));
  }
}
