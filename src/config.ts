// 設定。<configDir>/<CONFIG_FILE>（names.ts）を読み書きする。公開値（名前、ポート、根、ドメイン、Access の aud）と秘密（サービストークン、CF API トークン）を1つの 0600 のファイルにまとめる
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, hostname } from "node:os";
import { dirname, join } from "node:path";
import { CONFIG_ENV, CONFIG_FILE, configDirOf, LEGACY_CONFIG_ENV, LEGACY_CONFIG_FILE, legacyConfigDirOf, TUNNEL_PREFIX } from "./names";

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
// CONFIG_ENV（CCN_CONFIG。旧の CC_CONFIG も読む）で設定ファイルを差し替えられる（手元で別ポートのノードを試すとき用）
export const defaultPath = () => process.env[CONFIG_ENV] ?? process.env[LEGACY_CONFIG_ENV] ?? resolveConfigPath(homedir());

// 新の設定が無く旧（~/.config/cc/cc.json）があれば旧を読む。旧の ccn update が新しいコードを旧の置き場に入れて
// 旧の常駐で立ち上げたときに、既定の 4322・Access なしで立ち上がらないようにする。移すのは新しいコードの ccn update
export function resolveConfigPath(home: string, configDir = configDirOf(home)): string {
  const cur = join(configDir, CONFIG_FILE);
  const old = join(legacyConfigDirOf(home), LEGACY_CONFIG_FILE);
  return !existsSync(cur) && existsSync(old) ? old : cur;
}
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

// ノードのホスト名。1階層の <TUNNEL_PREFIX><name>.<zone>（トンネル名と同じ）にして、無料の証明書 *.<zone> で覆う。
// 2階層（<name>.cc.fybe.jp）は Advanced 証明書が要り、このアカウントには無い（2026-11-06 の移行で分かった）
export function nodeHost(name: string, cfg: { zone?: string; domain?: string }): string {
  const zone = cfg.zone ?? cfg.domain?.split(".").slice(1).join(".");
  if (!zone) throw new Error(`${CONFIG_FILE} に zone も domain も無い`);
  return hostFor(TUNNEL_PREFIX, name, zone);
}
export const hostFor = (prefix: string, name: string, zone: string) => `${prefix}${name}.${zone}`;

export function entryOf(cfg: Config): string | undefined {
  return cfg.entry ?? (cfg.domain ? `https://${cfg.domain}` : undefined);
}
