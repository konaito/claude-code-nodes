// 受け口（lobby）のディレクトリと CLAUDE.md、.claude/settings.json を用意する。ノードの起動、ccn install、ccn update が呼ぶ（何度呼んでも同じ結果になる）。
// 起動のときにも呼ぶのは、入れ替え前の旧コードが走る初回の ccn update では、install と update の中の処理が動かないため
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { CLI_NAME, configDirOf, LOBBY_TEMPLATE, legacyConfigDirOf, PRODUCT_NAME, TUNNEL_TOKEN_FILE } from "../names";

// home はノードを動かす利用者のホーム（秘密の置き場の基点）。configFile は読んでいる設定ファイル（CCN_CONFIG で既定の置き場の外にあることがあるので、そのファイルと隣の tunnel.token も deny に足す）
export type LobbyOptions = { dir: string; appRoot: string; nodeName: string; roots: string[]; home?: string; configFile?: string };
export type LobbySecrets = { home?: string; configFile?: string };
export const LOBBY_CLAUDE_MD = "CLAUDE.md";
export const LOBBY_SETTINGS = [".claude", "settings.json"]; // 本人が足す分は同じ場所の settings.local.json に書く

// 受け口が承認なしで使える命令。ひな形の手順に要るものだけにする。書き込み、削除、ネットワークに出る命令は入れない。
// ccn は下位命令ごとに許す（update、uninstall、node、setup、serve、send などは入れない）。
// ファイルを読む規則（Read）は入れない。Read(//<root>/**) を許すと、grep -r、rg、ワイルドカードの cat や head が deny をすり抜けたため（docs/results/2026-11-11-lobby.md）。
// 行き先を探す読み取りは ccn places（ノードが README と .git/config だけを読み、秘密の置き場を辿らない）に寄せる。git も入れない
export const LOBBY_CLI_SUBCOMMANDS = ["peers", "places", "ls", "show", "new", "run", "read", "allow", "deny", "stop"] as const;

// 承認の有無にかかわらず読ませない秘密の置き場。roots とホームのそれぞれを基点にする（roots がホームでない機械や、allow が効かない bypassPermissions でも塞ぐため）。
// deny は allow より先に評価され、allow で穴を開けられない（公式の permissions の文書）。Read の deny は Edit と Write、Bash の cat、head などにも当たる。
// 当たらないのは、パスを文字どおり書かずに読む命令（grep -r、rg、ワイルドカード）と、ファイルを自分で開くスクリプト。ccn places の判定（isSecretPath）も同じ一覧を使う
export const LOBBY_SECRET_DIRS = [".ssh", ".gnupg", ".aws", ".cloudflared", relativeToHome(configDirOf), relativeToHome(legacyConfigDirOf), ".config/gh", "Library/Keychains"] as const;
export const LOBBY_SECRET_FILES = [".netrc", ".claude/.credentials.json"] as const;
// どこにあっても読ませないファイル名（//** はファイルシステムの根から）
export const LOBBY_SECRET_NAMES = [".env", ".env.*", "*.pem", "*.key"] as const;
function relativeToHome(of: (home: string) => string): string { return relative("/h", of("/h")); }

// Read の // は絶対パス（先頭の / が1本だと設定ファイルの場所からの相対になる）
const readRule = (abs: string) => `Read(/${abs})`;

// 秘密の置き場の基点。roots とノードのホーム
export const secretBases = (roots: string[], s: LobbySecrets = {}): string[] => [...new Set([...roots, s.home ?? homedir()].map((r) => resolve(r)))];

// 名前が LOBBY_SECRET_NAMES に当たるか（.env、.env.*、*.pem、*.key）
const SECRET_NAME_RES = LOBBY_SECRET_NAMES.map((g) => new RegExp(`^${g.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".")}$`));
const secretName = (name: string) => SECRET_NAME_RES.some((re) => re.test(name));

// abs（絶対パス）が受け口の deny と同じ秘密の置き場に当たるか。ccn places がノードのプロセスで読むファイルとディレクトリを、この判定で選ぶ。
// ノードのプロセスには deny が効かないので、deny と同じ一覧をここでも使う。bases は symlink を解いた形も渡す
export function isSecretPath(abs: string, bases: string[], configFile?: string): boolean {
  const p = resolve(abs);
  for (const b of bases) {
    for (const d of LOBBY_SECRET_DIRS) { const dir = join(b, d); if (p === dir || p.startsWith(dir + sep)) return true; }
    for (const f of LOBBY_SECRET_FILES) if (p === join(b, f)) return true;
  }
  if (secretName(p.slice(p.lastIndexOf(sep) + 1))) return true;
  if (configFile) { const f = resolve(configFile); if (p === f || p === join(dirname(f), TUNNEL_TOKEN_FILE)) return true; }
  return false;
}

// dir の下に秘密の置き場があるか（~/Library の下の Keychains など）。そういうディレクトリは ccn places の候補にしない
export function containsSecretDir(abs: string, bases: string[]): boolean {
  const p = resolve(abs);
  return bases.some((b) => LOBBY_SECRET_DIRS.some((d) => join(b, d).startsWith(p + sep)));
}

export function lobbyDeny(roots: string[], s: LobbySecrets = {}): string[] {
  const bases = secretBases(roots, s);
  const rules: string[] = [];
  for (const b of bases) {
    for (const d of LOBBY_SECRET_DIRS) rules.push(readRule(`${join(b, d)}/**`));
    for (const f of LOBBY_SECRET_FILES) rules.push(readRule(join(b, f)));
  }
  for (const n of LOBBY_SECRET_NAMES) rules.push(readRule(`/**/${n}`));
  // CCN_CONFIG で別の場所の設定を読んでいるときは、そのファイルと隣のトンネルトークンも塞ぐ
  if (s.configFile) {
    const f = resolve(s.configFile);
    const covered = bases.some((b) => LOBBY_SECRET_DIRS.some((d) => f.startsWith(join(b, d) + sep)));
    if (!covered) rules.push(readRule(f), readRule(join(dirname(f), TUNNEL_TOKEN_FILE)));
  }
  return [...new Set(rules)];
}

export function lobbySettings(roots: string[], s: LobbySecrets = {}): { permissions: { allow: string[]; deny: string[] } } {
  return {
    permissions: {
      allow: LOBBY_CLI_SUBCOMMANDS.map((c) => `Bash(${CLI_NAME} ${c} *)`),
      deny: lobbyDeny(roots, s),
    },
  };
}
export const lobbySettingsText = (roots: string[], s: LobbySecrets = {}) => JSON.stringify(lobbySettings(roots, s), null, 2) + "\n";

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
  const settings = writeIfChanged(join(o.dir, ...LOBBY_SETTINGS), lobbySettingsText(o.roots, { home: o.home, configFile: o.configFile }));
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
