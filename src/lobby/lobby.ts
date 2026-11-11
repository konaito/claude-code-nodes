// 受け口（lobby）のディレクトリと CLAUDE.md を用意する。ノードの起動、ccn install、ccn update が呼ぶ（何度呼んでも同じ結果になる）。
// 起動のときにも呼ぶのは、入れ替え前の旧コードが走る初回の ccn update では、install と update の中の処理が動かないため
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { CLI_NAME, LOBBY_TEMPLATE, PRODUCT_NAME } from "../names";

export type LobbyOptions = { dir: string; appRoot: string; nodeName: string; roots: string[] };
export const LOBBY_CLAUDE_MD = "CLAUDE.md";

export function renderLobbyClaudeMd(template: string, o: Omit<LobbyOptions, "dir" | "appRoot"> & { dir: string }): string {
  return template
    .replaceAll("{{PRODUCT}}", PRODUCT_NAME)
    .replaceAll("{{CLI}}", CLI_NAME)
    .replaceAll("{{NODE}}", o.nodeName)
    .replaceAll("{{LOBBY}}", o.dir)
    .replaceAll("{{ROOTS}}", o.roots.map((r) => `\`${r}\``).join("、"));
}

// ディレクトリを作り、CLAUDE.md を書く。中身が同じなら書かない。CLAUDE.local.md（本人が足す分）には触らない
export function ensureLobby(o: LobbyOptions): { dir: string; written: boolean } {
  const template = readFileSync(join(o.appRoot, ...LOBBY_TEMPLATE), "utf8");
  const text = renderLobbyClaudeMd(template, o);
  mkdirSync(o.dir, { recursive: true });
  const path = join(o.dir, LOBBY_CLAUDE_MD);
  const cur = existsSync(path) ? readFileSync(path, "utf8") : undefined;
  if (cur === text) return { dir: o.dir, written: false };
  writeFileSync(path, text);
  return { dir: o.dir, written: true };
}

// roots の内側か確かめてから用意する。外なら作らない（cwd を省いた作成は API が 400 で断る）
export function prepareLobby(o: LobbyOptions): { dir: string; written: boolean } | { dir: string; error: string } {
  const dir = resolve(o.dir);
  if (!o.roots.some((r) => dir === resolve(r) || dir.startsWith(resolve(r) + sep))) return { dir, error: `outside roots (${o.roots.join(", ")})` };
  try { return ensureLobby({ ...o, dir }); }
  catch (e) { return { dir, error: e instanceof Error ? e.message : String(e) }; }
}
