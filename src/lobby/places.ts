// 行き先の候補（ccn places、GET /api/places、MCP の list_places）。受け口が ls、cat、grep で roots を読む代わりに、ノードが決まったファイルだけを読んで返す。
// ノードのプロセスには受け口の deny が効かないので、読むのは候補ディレクトリの README と git の設定（.git/config、worktree なら .git の1行と commondir）だけにする。
// どのファイルも symlink を解いた実体で、roots の内側にあり、受け口の deny と同じ秘密の置き場（lobby.ts の isSecretPath）に当たらないことを確かめてから読む
import { lstat, open, readdir, realpath, stat } from "node:fs/promises";
import { basename, join, resolve, sep } from "node:path";
import { containsSecretDir, isSecretPath } from "./lobby";

export type Place = {
  name: string;
  path: string;           // symlink を解いた絶対パス
  remote: string | null;  // origin（無ければ最初の remote）の url。https の利用者名と token は消す
  readme: string[];       // README の先頭の空でない行
  lastUsedAt: number | null; // このディレクトリかその下で動いたセッションの最後の活動（ms）
};
export type ScannedPlace = Omit<Place, "lastUsedAt"> & { mtimeMs: number };
export type PlacesQuery = { q?: string; limit?: number };
export type PlacesResult = { places: Place[]; total: number; truncated: boolean };

export const PLACES_DEFAULT_LIMIT = 60;
export const PLACES_MAX_LIMIT = 300;
export const PLACES_MAX_DIRS = 1000;        // 1回の走査で見るディレクトリの上限
export const PLACES_MAX_CHARS = 16_000;     // 返す places の JSON の文字数の上限（MCP の1回の結果 20,000 字に収める）
const README_LINES = 5;                     // 語で絞ったときに返す README の行数。絞らないときは1行
const README_LINE_CHARS = 160;
const README_BYTES = 4096;
const GIT_BYTES = 64 * 1024;
const REMOTE_CHARS = 200;
const README_RE = /^readme(\.(md|markdown|txt|rst))?$/i;

export type ScanOptions = { roots: string[]; bases: string[]; configFile?: string; lobby?: string; maxDirs?: number };

const real = (p: string) => realpath(p).catch(() => null);
const under = (p: string, roots: string[]) => roots.some((r) => p === r || p.startsWith(r.endsWith(sep) ? r : r + sep));

// 秘密の判定に使う基点。symlink を解いた形（/tmp と /private/tmp など）も足す
async function withReal(paths: string[]): Promise<string[]> {
  const out = new Set(paths.map((p) => resolve(p)));
  for (const p of paths) { const r = await real(resolve(p)); if (r) out.add(r); }
  return [...out];
}

type Guard = { roots: string[]; bases: string[]; configFile?: string };
// 読んでよい通常のファイルなら先頭 max バイトを返す。symlink は実体で判定する
async function safeRead(path: string, max: number, g: Guard): Promise<string | null> {
  const p = await real(path);
  if (!p || !under(p, g.roots) || isSecretPath(p, g.bases, g.configFile) || isSecretPath(path, g.bases, g.configFile)) return null;
  const st = await stat(p).catch(() => null);
  if (!st?.isFile()) return null;
  const fh = await open(p, "r").catch(() => null);
  if (!fh) return null;
  try {
    const buf = Buffer.alloc(Math.min(max, st.size));
    const { bytesRead } = await fh.read(buf, 0, buf.length, 0);
    return buf.subarray(0, bytesRead).toString("utf8");
  } finally { await fh.close(); }
}

// README の先頭の空でない行。バッジや HTML だけの行は飛ばす
function readmeLines(text: string): string[] {
  const out: string[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const l = raw.trim();
    if (!l || /^(\[!\[|<|!\[|---+$|===+$)/.test(l)) continue;
    out.push(l.length > README_LINE_CHARS ? l.slice(0, README_LINE_CHARS) + "…" : l);
    if (out.length >= README_LINES) break;
  }
  return out;
}

// url から利用者名とパスワード（token）を消す。scp の形（git@host:path）はそのまま
export function cleanRemote(url: string): string {
  const u = url.trim().replace(/^([a-z][a-z0-9+.-]*:\/\/)[^@/]*@/i, "$1");
  return u.length > REMOTE_CHARS ? u.slice(0, REMOTE_CHARS) + "…" : u;
}

// git の設定から remote の url だけを取る（ほかの鍵、たとえば http.extraheader は読まない）。origin を先にする
export function remoteOf(config: string): string | null {
  let section: string | null = null;
  const urls: Array<{ name: string; url: string }> = [];
  for (const raw of config.split(/\r?\n/)) {
    const l = raw.trim();
    const h = l.match(/^\[\s*remote\s+"([^"]*)"\s*\]$/i);
    if (h) { section = h[1]!; continue; }
    if (l.startsWith("[")) { section = null; continue; }
    if (section === null) continue;
    const kv = l.match(/^url\s*=\s*(.*)$/i);
    if (kv && kv[1]) urls.push({ name: section, url: kv[1].replace(/^"(.*)"$/, "$1") });
  }
  const pick = urls.find((u) => u.name === "origin") ?? urls[0];
  return pick ? cleanRemote(pick.url) : null;
}

// dir/.git がディレクトリならその config、ファイル（worktree）なら gitdir の commondir の config を読む
async function gitConfigOf(dir: string, g: Guard): Promise<string | null> {
  const dotgit = join(dir, ".git");
  const st = await lstat(dotgit).catch(() => null);
  if (!st) return null;
  if (st.isDirectory()) return safeRead(join(dotgit, "config"), GIT_BYTES, g);
  if (!st.isFile()) return null;
  const head = await safeRead(dotgit, 1024, g);
  const m = head?.match(/^gitdir:\s*(.+)$/m);
  if (!m) return null;
  const gitdir = resolve(dir, m[1]!.trim());
  const common = await safeRead(join(gitdir, "commondir"), 1024, g);
  return safeRead(join(common ? resolve(gitdir, common.trim()) : gitdir, "config"), GIT_BYTES, g);
}

async function placeOf(path: string, mtimeMs: number, g: Guard): Promise<ScannedPlace> {
  const names = await readdir(path).catch(() => [] as string[]);
  const rm = names.filter((n) => README_RE.test(n)).sort((a, b) => a.localeCompare(b))[0];
  const text = rm ? await safeRead(join(path, rm), README_BYTES, g) : null;
  const cfg = await gitConfigOf(path, g);
  return { name: basename(path), path, remote: cfg ? remoteOf(cfg) : null, readme: text ? readmeLines(text) : [], mtimeMs };
}

// roots の直下と、roots の下の Documents の直下のディレクトリを候補にする。
// 飛ばすもの: . で始まる名前、秘密の置き場とそれを含むディレクトリ、受け口、roots の外に出る symlink、Documents そのもの
export async function scanPlaces(o: ScanOptions): Promise<ScannedPlace[]> {
  const roots = [...new Set(await Promise.all(o.roots.map(async (r) => (await real(resolve(r))) ?? resolve(r))))];
  const bases = await withReal(o.bases);
  const g: Guard = { roots, bases, configFile: o.configFile };
  const lobby = o.lobby ? (await real(resolve(o.lobby))) ?? resolve(o.lobby) : undefined;
  const parents: string[] = [];
  for (const r of roots) {
    parents.push(r);
    const docs = await real(join(r, "Documents"));
    if (docs && under(docs, roots) && (await stat(docs).catch(() => null))?.isDirectory()) parents.push(docs);
  }
  const seen = new Set<string>();
  const found: Array<{ path: string; mtimeMs: number }> = [];
  const max = o.maxDirs ?? PLACES_MAX_DIRS;
  for (const parent of [...new Set(parents)]) {
    const ents = await readdir(parent, { withFileTypes: true }).catch(() => []);
    for (const e of ents) {
      if (found.length >= max) break;
      if (e.name.startsWith(".")) continue;
      if (!e.isDirectory() && !e.isSymbolicLink()) continue;
      const p = await real(join(parent, e.name));
      if (!p || seen.has(p) || !under(p, roots) || parents.includes(p)) continue;
      if (p === lobby) continue;
      if (isSecretPath(p, bases, o.configFile) || isSecretPath(join(parent, e.name), bases, o.configFile) || containsSecretDir(p, bases)) continue;
      const st = await stat(p).catch(() => null);
      if (!st?.isDirectory()) continue;
      seen.add(p);
      found.push({ path: p, mtimeMs: st.mtimeMs });
    }
  }
  return Promise.all(found.map((f) => placeOf(f.path, f.mtimeMs, g)));
}

// 最近のセッションの cwd（symlink を解いたもの）から、候補ごとの最後の活動を出す
export function usageOf(places: ScannedPlace[], sessions: Array<{ cwd: string; lastActivityAt: number }>): Map<string, number> {
  const used = new Map<string, number>();
  for (const s of sessions) {
    for (const p of places) {
      if (s.cwd === p.path || s.cwd.startsWith(p.path + sep)) used.set(p.path, Math.max(used.get(p.path) ?? 0, s.lastActivityAt));
    }
  }
  return used;
}

// 語で絞り（どれかの語が名前、パス、remote、README に入るもの）、最近使われた順、変更の新しい順に並べ、件数と文字数で切る
export function selectPlaces(all: ScannedPlace[], used: Map<string, number>, q: PlacesQuery = {}): PlacesResult {
  const words = (q.q ?? "").toLowerCase().split(/\s+/).filter(Boolean);
  const hits = (p: ScannedPlace) => { const hay = [p.name, p.path, p.remote ?? "", ...p.readme].join("\n").toLowerCase(); return words.filter((w) => hay.includes(w)).length; };
  const scored = all.map((p) => ({ p, score: words.length ? hits(p) : 0, used: used.get(p.path) ?? null }))
    .filter((x) => !words.length || x.score > 0)
    .sort((a, b) => b.score - a.score || (b.used ?? 0) - (a.used ?? 0) || b.p.mtimeMs - a.p.mtimeMs || a.p.path.localeCompare(b.p.path));
  const limit = Math.min(Math.max(1, Math.floor(q.limit ?? PLACES_DEFAULT_LIMIT)), PLACES_MAX_LIMIT);
  const places: Place[] = [];
  let chars = 0;
  for (const { p, used } of scored) {
    if (places.length >= limit) break;
    const item: Place = { name: p.name, path: p.path, remote: p.remote, readme: words.length ? p.readme : p.readme.slice(0, 1), lastUsedAt: used };
    const size = JSON.stringify(item).length + 1;
    if (chars + size > PLACES_MAX_CHARS) break;
    chars += size;
    places.push(item);
  }
  return { places, total: scored.length, truncated: places.length < scored.length };
}
