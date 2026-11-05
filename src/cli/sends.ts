// CLI の手元の控え。送った文の直前の seq を覚え、read の既定の after にする。ノードではなく CLI のファイル（~/.config/cc/sends.json）
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

type Sends = Record<string, number>;
function load(path: string): Sends {
  try { return JSON.parse(readFileSync(path, "utf8")) as Sends; } catch { return {}; }
}
export function rememberSeq(key: string, seq: number, path: string): void {
  const all = load(path);
  all[key] = seq;
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(all, null, 2) + "\n");
}
export function lastSeq(key: string, path: string): number | undefined {
  const v = load(path)[key];
  return typeof v === "number" ? v : undefined;
}
