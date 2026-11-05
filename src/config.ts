// 設定。~/.config/cc/cc.json を読み、無ければ既定値（名前はホスト名、ポート 4322、根はホーム）
import { readFileSync } from "node:fs";
import { homedir, hostname } from "node:os";
import { join } from "node:path";

export type Config = { name: string; port: number; roots: string[] };
export const defaultPath = () => join(homedir(), ".config", "cc", "cc.json");

export function loadConfig(path = defaultPath()): Config {
  let raw: Partial<Config> = {};
  try { raw = JSON.parse(readFileSync(path, "utf8")) as Partial<Config>; } catch { /* 無ければ既定値 */ }
  return {
    name: typeof raw.name === "string" && raw.name ? raw.name : hostname().replace(/\.local$/, ""),
    port: Number.isInteger(raw.port) ? (raw.port as number) : 4322,
    roots: Array.isArray(raw.roots) && raw.roots.length ? raw.roots : [homedir()],
  };
}
