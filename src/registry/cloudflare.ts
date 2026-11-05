// Cloudflare のトンネル一覧を登録簿として読む。名前が cc- で始まるトンネルを全部ノードとみなす。許可リストは持たない
import { RegistryError, type Peer, type PeerStatus, type Registry } from "./registry";

export type CloudflareDeps = {
  accountId: string;
  apiToken: string;    // Cloudflare Tunnel Read
  domain: string;      // <name>.<domain> がノードの URL
  selfName: string;
  prefix?: string;     // 既定 "cc-"
  fetchFn?: typeof fetch;
  cacheMs?: number;    // 既定 10 秒
  now?: () => number;
};
type Tunnel = { id: string; name: string; status: PeerStatus };

export class CloudflareRegistry implements Registry {
  private cache?: { at: number; value: Promise<Peer[]> };
  private prefix: string;
  private fetchFn: typeof fetch;
  private cacheMs: number;
  private now: () => number;

  constructor(private deps: CloudflareDeps) {
    this.prefix = deps.prefix ?? "cc-";
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
    return (body.result ?? [])
      .filter((t) => t.name.startsWith(this.prefix))
      .map((t) => { const name = t.name.slice(this.prefix.length); return { name, url: `https://${name}.${this.deps.domain}`, status: t.status, self: name === this.deps.selfName }; })
      .sort((a, b) => a.name.localeCompare(b.name));
  }
}
