// 設定。~/.config/cc/cc.json を読み書きする。公開値（名前、ポート、根、ドメイン、Access の aud）と秘密（サービストークン、CF API トークン）を1つの 0600 のファイルにまとめる
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, hostname } from "node:os";
import { dirname, join } from "node:path";

export type Config = {
  name: string;
  port: number;
  roots: string[];
  domain?: string;       // 例 cc.fybe.jp。ノードのホスト名は <name>.<domain>
  teamDomain?: string;   // 例 fybejp.cloudflareaccess.com
  aud?: string;          // Access アプリの aud
  accountId?: string;    // Cloudflare のアカウント ID
  zone?: string;         // DNS のゾーン。例 fybe.jp
  entry?: string;        // 入口の URL。無ければ https://<domain>
  serviceToken?: { clientId: string; clientSecret: string }; // ノード用サービストークン
  cfApiToken?: string;   // 登録簿を読む CF API トークン（Cloudflare Tunnel Read）
};
// CC_CONFIG で設定ファイルを差し替えられる（手元で別ポートのノードを試すとき用）
export const defaultPath = () => process.env.CC_CONFIG ?? join(homedir(), ".config", "cc", "cc.json");
export const APP_VERSION: string = (JSON.parse(readFileSync(join(import.meta.dir, "..", "package.json"), "utf8")) as { version: string }).version;

const str = (v: unknown): string | undefined => (typeof v === "string" && v ? v : undefined);

export function loadConfig(path = defaultPath()): Config {
  let raw: Record<string, unknown> = {};
  try { raw = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>; } catch { /* 無ければ既定値 */ }
  const cfg: Config = {
    name: str(raw.name) ?? hostname().replace(/\.local$/, ""),
    port: Number.isInteger(raw.port) ? (raw.port as number) : 4322,
    roots: Array.isArray(raw.roots) && raw.roots.length ? (raw.roots as string[]) : [homedir()],
  };
  for (const k of ["domain", "teamDomain", "aud", "accountId", "zone", "entry", "cfApiToken"] as const) {
    const v = str(raw[k]);
    if (v) cfg[k] = v;
  }
  const t = raw.serviceToken as Record<string, unknown> | undefined;
  if (t && str(t.clientId) && str(t.clientSecret)) cfg.serviceToken = { clientId: t.clientId as string, clientSecret: t.clientSecret as string };
  return cfg;
}

// 親ディレクトリを作り、秘密を含むので 0600 で書く
export function saveConfig(cfg: Config, path = defaultPath()): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, JSON.stringify(cfg, null, 2) + "\n", { mode: 0o600 });
  chmodSync(path, 0o600);
}

export function entryOf(cfg: Config): string | undefined {
  return cfg.entry ?? (cfg.domain ? `https://${cfg.domain}` : undefined);
}
