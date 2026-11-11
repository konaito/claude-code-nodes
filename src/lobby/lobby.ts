// 受け口（lobby）のディレクトリと CLAUDE.md、.claude/settings.json を用意する。ノードの起動、ccn install、ccn update が呼ぶ（何度呼んでも同じ結果になる）。
// 起動のときにも呼ぶのは、入れ替え前の旧コードが走る初回の ccn update では、install と update の中の処理が動かないため
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { realpath } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { CLI_NAME, LOBBY_TEMPLATE, PRODUCT_NAME } from "../names";

export type LobbyOptions = { dir: string; appRoot: string; nodeName: string; roots: string[] };
export const LOBBY_CLAUDE_MD = "CLAUDE.md";
export const LOBBY_SETTINGS = [".claude", "settings.json"]; // 本人が足す分は同じ場所の settings.local.json に書く

// 受け口が承認なしで使える命令。ひな形の手順に要るものだけにする。書き込み、削除、ネットワークに出る命令は入れない。
// ccn は下位命令ごとに許す（update、uninstall、node、setup、serve、send などは入れない）。読むのは roots の下だけ。
// git は入れない。git -C <dir> remote -v を許す規則は * を下位命令の前に置くことになり、-c で別の program を走らせる形まで通るため。
// remote はひな形で <dir>/.git/config を読ませる
export const LOBBY_CLI_SUBCOMMANDS = ["peers", "ls", "show", "new", "run", "read", "allow", "deny", "stop"] as const;
export function lobbySettings(roots: string[]): { permissions: { allow: string[] } } {
  return {
    permissions: {
      allow: [
        ...LOBBY_CLI_SUBCOMMANDS.map((c) => `Bash(${CLI_NAME} ${c} *)`),
        // Read の // は絶対パス（先頭の / が1本だと設定ファイルの場所からの相対になる）。ls、head、cat の対象もこれで決まる
        ...roots.map((r) => `Read(/${resolve(r)}/**)`),
      ],
    },
  };
}
export const lobbySettingsText = (roots: string[]) => JSON.stringify(lobbySettings(roots), null, 2) + "\n";

export function renderLobbyClaudeMd(template: string, o: Omit<LobbyOptions, "dir" | "appRoot"> & { dir: string }): string {
  return template
    .replaceAll("{{PRODUCT}}", PRODUCT_NAME)
    .replaceAll("{{CLI}}", CLI_NAME)
    .replaceAll("{{NODE}}", o.nodeName)
    .replaceAll("{{LOBBY}}", o.dir)
    .replaceAll("{{ROOTS}}", o.roots.map((r) => `\`${r}\``).join("、"))
    .replaceAll("{{DOCUMENTS}}", o.roots.map((r) => `\`${join(resolve(r), "Documents")}\``).join("、"));
}

// 中身が同じなら書かない。書いたら true
function writeIfChanged(path: string, text: string): boolean {
  if (existsSync(path) && readFileSync(path, "utf8") === text) return false;
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
  return true;
}

// ディレクトリを作り、CLAUDE.md と .claude/settings.json を書く。中身が同じなら書かない。
// CLAUDE.local.md と .claude/settings.local.json（本人が足す分）には触らない
export function ensureLobby(o: LobbyOptions): { dir: string; written: boolean } {
  const template = readFileSync(join(o.appRoot, ...LOBBY_TEMPLATE), "utf8");
  mkdirSync(o.dir, { recursive: true });
  const md = writeIfChanged(join(o.dir, LOBBY_CLAUDE_MD), renderLobbyClaudeMd(template, o));
  const settings = writeIfChanged(join(o.dir, ...LOBBY_SETTINGS), lobbySettingsText(o.roots));
  return { dir: o.dir, written: md || settings };
}

// 受け口のセッションに --settings で渡すファイル。cwd（realpath 済み）が受け口のときだけ返す。
// .claude/settings.json の allow は、信頼の確認を出さない SDK のセッションでは使われない（未信頼のフォルダとして無視される）ので、
// 同じファイルを SDK の settings（CLI の --settings）でも渡す。受け口が立てた子は別の cwd で動くので渡らない
export async function lobbySettingsFor(cwd: string, lobby: string): Promise<string | undefined> {
  const real = await realpath(resolve(lobby)).catch(() => undefined);
  if (!real || cwd !== real) return undefined;
  const path = join(real, ...LOBBY_SETTINGS);
  return existsSync(path) ? path : undefined;
}

// roots の内側か確かめてから用意する。外なら作らない（cwd を省いた作成は API が 400 で断る）
export function prepareLobby(o: LobbyOptions): { dir: string; written: boolean } | { dir: string; error: string } {
  const dir = resolve(o.dir);
  if (!o.roots.some((r) => dir === resolve(r) || dir.startsWith(resolve(r) + sep))) return { dir, error: `outside roots (${o.roots.join(", ")})` };
  try { return ensureLobby({ ...o, dir }); }
  catch (e) { return { dir, error: e instanceof Error ? e.message : String(e) }; }
}
