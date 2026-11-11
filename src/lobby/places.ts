// 行き先の候補（ccn places、GET /api/places、MCP の list_places）。受け口が ls、cat、grep で roots を読む代わりに、ノードが決まったファイルだけを読んで返す。
// ノードのプロセスには受け口の deny が効かないので、読むのは候補ディレクトリの README と git の設定（.git/config、worktree なら .git の1行と commondir）だけにする。
// どのファイルも symlink を解いた実体で、roots の内側にあり、受け口の deny と同じ秘密の置き場（lobby.ts の isSecretPath）に当たらないことを確かめてから読む
// macOS では、ノード（launchd の常駐の bun）の places が返らなくなった（2026-11-11、incertotech）。スレッドが openat で止まっており、保護フォルダ（Desktop、Downloads など）の承認（TCC）の待ちとみているが、原因は未確認。
// そのため、保護フォルダには readdir も stat も当てない（MAC_PROTECTED）。ほかの場所で止まっても API が待ち続けないよう、fs の呼び出しごとと走査全体に時間の上限を付ける（PlacesScanner）
import { lstat, open, readdir, readlink, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, resolve, sep } from "node:path";
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
// partial は、時間切れや前に止まったディレクトリのために、読めなかった場所があったこと。unreadable はその場所（前の走査で止まって覚えているものを含む）
export type ScanResult = { places: ScannedPlace[]; partial: boolean; unreadable: string[] };

export const PLACES_DEFAULT_LIMIT = 60;
export const PLACES_MAX_LIMIT = 300;
export const PLACES_MAX_DIRS = 1000;        // 1回の走査で見るディレクトリの上限
export const PLACES_MAX_CHARS = 16_000;     // 返す places の JSON の文字数の上限（MCP の1回の結果 20,000 字に収める）
export const PLACES_DEADLINE_MS = 3000;     // 走査全体の時間の上限。過ぎたらそれまでに集めた分を返す
export const PLACES_OP_MS = 1000;           // fs の呼び出し1回の上限。過ぎたらそのディレクトリを止まったものとして覚え、ノードが動いている間は開かない
export const PLACES_CACHE_MS = 10_000;      // 走査の結果を覚える時間（走査が終わってから）
const PLACES_WORKERS = 8;                   // 候補の README と .git を同時に読む数
const README_LINES = 5;                     // 語で絞ったときに返す README の行数。絞らないときは先頭の2行を / でつないだ1行
const README_LINE_CHARS = 160;
const README_BYTES = 4096;
const GIT_BYTES = 64 * 1024;
const REMOTE_CHARS = 200;
const README_RE = /^readme(\.(md|markdown|txt|rst))?$/i;

// macOS のホームの直下で開かない場所。
// TCC の対象（Apple Platform Security の「Controlling app access to files in macOS」と、この機械の TCC.framework の承認の文言で確かめた）:
//   Desktop、Downloads（kTCCServiceSystemPolicyDesktopFolder、DownloadsFolder）、
//   Library（Mobile Documents は iCloud Drive、CloudStorage は FileProvider、Containers と Group Containers は SystemPolicyAppData）、
//   Pictures（写真ライブラリ、kTCCServicePhotos）、Music（ミュージックのライブラリ、kTCCServiceMediaLibrary）。
// TCC の対象だという根拠は無いが、行き先にならない標準のフォルダなので外すもの: Movies、Public、Applications、iCloud Drive（利用者が置く symlink の名前）。
// Documents も TCC の対象（DocumentsFolder）だが、受け口の主な行き先なので外さない。止まったときは時間の上限で抜ける
export const MAC_PROTECTED = ["Desktop", "Downloads", "Library", "Pictures", "Music", "Movies", "Public", "Applications", "iCloud Drive"] as const;
// symlink の先が取り外しやネットワークのボリューム（kTCCServiceSystemPolicyRemovableVolumes、NetworkVolumes）なら開かない
const MAC_VOLUMES = "/Volumes";

export type Ent = { name: string; isDirectory(): boolean; isSymbolicLink(): boolean };
type StatLike = { isDirectory(): boolean; isFile(): boolean; isSymbolicLink?(): boolean; size: number; mtimeMs: number };
// places が使う fs。試験で止まる偽物に差し替える
export type PlacesFs = {
  readdir(p: string): Promise<Ent[]>;
  realpath(p: string): Promise<string>;
  stat(p: string): Promise<StatLike>;
  lstat(p: string): Promise<StatLike & { isSymbolicLink(): boolean }>;
  readlink(p: string): Promise<string>;
  readHead(p: string, max: number): Promise<string>; // 先頭 max バイト
};
export const nodeFs: PlacesFs = {
  readdir: (p) => readdir(p, { withFileTypes: true }),
  realpath: (p) => realpath(p),
  stat: (p) => stat(p),
  lstat: (p) => lstat(p),
  readlink: (p) => readlink(p),
  readHead: async (p, max) => {
    const fh = await open(p, "r");
    try {
      const buf = Buffer.alloc(max);
      const { bytesRead } = await fh.read(buf, 0, max, 0);
      return buf.subarray(0, bytesRead).toString("utf8");
    } finally { await fh.close(); }
  },
};

export type ScanOptions = {
  roots: string[]; bases: string[]; configFile?: string; lobby?: string; maxDirs?: number;
  home?: string;               // MAC_PROTECTED の基点。無ければ os.homedir()
  platform?: NodeJS.Platform;  // darwin のときだけ MAC_PROTECTED を飛ばす。無ければ process.platform
};

const under = (p: string, roots: string[]) => roots.some((r) => p === r || p.startsWith(r.endsWith(sep) ? r : r + sep));

// 走査をまたいで覚えること。stuck は fs の呼び出し1回の上限を超えたパス（ノードが動いている間は開かない）。
// pending は、呼び出しがまだ返っていないパス（時間切れで見捨てても、裏のスレッドは止まったまま）。返るまでは同じパスを開かず、止まったスレッドを増やさない
export type PlacesMemory = { stuck: Set<string>; pending: Map<string, number> };
export const newPlacesMemory = (): PlacesMemory => ({ stuck: new Set(), pending: new Map() });
export type GuardOptions = { fs?: PlacesFs; memory?: PlacesMemory; deadlineMs?: number; opMs?: number };

// 1回の走査の fs の呼び出しを見張る。どの呼び出しも、上限のうちに値か null で返る
class Watch {
  readonly fs: PlacesFs;
  private mem: PlacesMemory;
  private deadlineAt: number;
  private opMs: number;
  expired = false;
  readonly unreadable = new Set<string>();
  constructor(o: GuardOptions) {
    this.fs = o.fs ?? nodeFs;
    this.mem = o.memory ?? newPlacesMemory();
    this.deadlineAt = Date.now() + (o.deadlineMs ?? PLACES_DEADLINE_MS);
    this.opMs = o.opMs ?? PLACES_OP_MS;
  }
  // key（とその上）が止まったものとして覚えられているか、まだ返っていない呼び出しがあるか
  blocked(key: string): string | null {
    for (const s of this.mem.stuck) if (under(key, [s])) return s;
    for (const s of this.mem.pending.keys()) if (under(key, [s])) return s;
    return null;
  }
  get partial() { return this.expired || this.unreadable.size > 0; }
  async op<T>(key: string, fn: (fs: PlacesFs) => Promise<T>): Promise<T | null> {
    if (this.expired) return null;
    const b = this.blocked(key);
    if (b) { this.unreadable.add(b); return null; }
    const left = this.deadlineAt - Date.now();
    if (left <= 0) { this.expired = true; return null; }
    const mem = this.mem;
    mem.pending.set(key, (mem.pending.get(key) ?? 0) + 1);
    const settle = () => { const n = (mem.pending.get(key) ?? 1) - 1; if (n > 0) mem.pending.set(key, n); else mem.pending.delete(key); };
    const work = Promise.resolve().then(() => fn(this.fs)).then((v) => v, () => null).finally(settle);
    const wait = Math.min(this.opMs, left);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const late = new Promise<"late">((r) => { timer = setTimeout(() => r("late"), wait); });
    const v = await Promise.race([work, late]);
    clearTimeout(timer);
    if (v !== "late") return v as T | null;
    // 呼び出し1回の上限を超えたものだけ覚える。全体の時間切れで待ちを切っただけのもの（遅いだけかもしれない）は覚えない
    if (wait >= this.opMs) { mem.stuck.add(key); this.unreadable.add(key); }
    else this.expired = true;
    return null;
  }
  real(p: string, key = p) { return this.op(key, (fs) => fs.realpath(p)); }
}

type Guard = { roots: string[]; bases: string[]; configFile?: string; w: Watch; key: string };
// 読んでよい通常のファイルなら先頭 max バイトを返す。symlink は実体で判定する
async function safeRead(path: string, max: number, g: Guard): Promise<string | null> {
  if (isSecretPath(path, g.bases, g.configFile)) return null;
  const p = await g.w.real(path, g.key);
  if (!p || !under(p, g.roots) || isSecretPath(p, g.bases, g.configFile)) return null;
  const st = await g.w.op(g.key, (fs) => fs.stat(p));
  if (!st?.isFile()) return null;
  return g.w.op(g.key, (fs) => fs.readHead(p, Math.min(max, st.size)));
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
  const st = await g.w.op(g.key, (fs) => fs.lstat(dotgit));
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

async function placeOf(path: string, mtimeMs: number, g: Omit<Guard, "key">): Promise<ScannedPlace | null> {
  const gg = { ...g, key: path };
  const names = (await g.w.op(path, (fs) => fs.readdir(path)))?.map((e) => e.name);
  if (!names) return null; // 中を開けなかった（止まった、時間切れ）候補は返さない
  const rm = names.filter((n) => README_RE.test(n)).sort((a, b) => a.localeCompare(b))[0];
  const text = rm ? await safeRead(join(path, rm), README_BYTES, gg) : null;
  const cfg = await gitConfigOf(path, gg);
  return { name: basename(path), path, remote: cfg ? remoteOf(cfg) : null, readme: text ? readmeLines(text) : [], mtimeMs };
}

// macOS で開かない場所（ホームの直下の MAC_PROTECTED と /Volumes）。roots がその中にあれば、その root の下は利用者が選んだ場所なので開く
export function protectedPaths(o: { home?: string; platform?: NodeJS.Platform; roots: string[] }): string[] {
  if ((o.platform ?? process.platform) !== "darwin") return [];
  const home = resolve(o.home ?? homedir());
  return [...MAC_PROTECTED.map((n) => join(home, n)), MAC_VOLUMES].filter((p) => !o.roots.some((r) => under(r, [p])));
}
export const isProtected = (p: string, prot: string[]) => under(resolve(p), prot);

// roots の直下と、roots の下の Documents の直下のディレクトリを候補にする。
// 飛ばすもの: . で始まる名前、macOS の保護フォルダ、秘密の置き場とそれを含むディレクトリ、受け口、roots の外に出る symlink、Documents そのもの。
// 飛ばす判定は、パスの字面で、そのパスに fs を当てる前に行う
export async function scanPlaces(o: ScanOptions, go: GuardOptions = {}): Promise<ScanResult> {
  const w = new Watch(go);
  const rawRoots = o.roots.map((r) => resolve(r));
  const roots = [...new Set(await Promise.all(rawRoots.map(async (r) => (await w.real(r)) ?? r)))];
  const bases = [...new Set([...o.bases.map((b) => resolve(b)), ...(await Promise.all(o.bases.map((b) => w.real(resolve(b))))).filter((b): b is string => !!b)])];
  const home = resolve(o.home ?? homedir());
  const realHome = (await w.real(home)) ?? home;
  const prot = [...new Set([...protectedPaths({ ...o, home, roots: [...rawRoots, ...roots] }), ...protectedPaths({ ...o, home: realHome, roots: [...rawRoots, ...roots] })])];
  const g = { roots, bases, configFile: o.configFile, w };
  const lobby = o.lobby ? (await w.real(resolve(o.lobby))) ?? resolve(o.lobby) : undefined;
  const skip = (p: string) => isProtected(p, prot) || isSecretPath(p, bases, o.configFile) || containsSecretDir(p, bases);
  const parents: string[] = [];
  for (const r of roots) {
    parents.push(r);
    const raw = join(r, "Documents");
    if (skip(raw)) continue;
    const docs = await w.real(raw);
    if (docs && under(docs, roots) && !skip(docs) && (await w.op(docs, (fs) => fs.stat(docs)))?.isDirectory()) parents.push(docs);
  }
  const seen = new Set<string>();
  const found: Array<{ path: string; mtimeMs: number }> = [];
  const max = o.maxDirs ?? PLACES_MAX_DIRS;
  for (const parent of [...new Set(parents)]) {
    const ents = (await w.op(parent, (fs) => fs.readdir(parent))) ?? [];
    for (const e of ents) {
      if (found.length >= max || w.expired) break;
      if (e.name.startsWith(".")) continue;
      if (!e.isDirectory() && !e.isSymbolicLink()) continue;
      const raw = join(parent, e.name);
      if (skip(raw) || raw === lobby) continue;
      // symlink は先を字面で解き、保護フォルダや秘密の置き場を指していれば realpath も当てない
      if (e.isSymbolicLink()) {
        const to = await w.op(raw, (fs) => fs.readlink(raw));
        if (!to || skip(resolve(dirname(raw), to))) continue;
      }
      const p = await w.real(raw);
      if (!p || seen.has(p) || !under(p, roots) || parents.includes(p)) continue;
      if (p === lobby || skip(p)) continue;
      const st = await w.op(p, (fs) => fs.stat(p));
      if (!st?.isDirectory()) continue;
      seen.add(p);
      found.push({ path: p, mtimeMs: st.mtimeMs });
    }
  }
  // 候補の README と .git は少数ずつ読み、時間切れならそれまでに読めた分を返す
  const places: ScannedPlace[] = [];
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(PLACES_WORKERS, found.length) }, async () => {
    while (next < found.length && !w.expired) {
      const f = found[next++]!;
      const p = await placeOf(f.path, f.mtimeMs, g);
      if (p) places.push(p);
    }
  }));
  if (next < found.length) w.expired = true;
  return { places, partial: w.partial, unreadable: [...w.unreadable].sort() };
}

// セッションの cwd の symlink を解く。roots の外と保護フォルダの中は解かずにそのまま返す（places の候補は roots の内側で保護フォルダの外にしかない）
export async function resolveCwds(cwds: string[], o: { roots: string[]; home?: string; platform?: NodeJS.Platform }, go: GuardOptions = {}): Promise<Map<string, string>> {
  const w = new Watch(go);
  const roots = o.roots.map((r) => resolve(r));
  const prot = protectedPaths({ ...o, roots });
  const out = new Map<string, string>();
  await Promise.all([...new Set(cwds)].map(async (c) => {
    const p = resolve(c);
    out.set(c, under(p, roots) && !isProtected(p, prot) ? (await w.real(p)) ?? c : c);
  }));
  return out;
}

// 走査を1つにまとめる（single-flight）。進んでいる走査があればそれを待ち、終わった走査の結果は PLACES_CACHE_MS だけ使い回す。
// 止まったパスの記憶（PlacesMemory）はノードが動いている間ずっと持つ
export class PlacesScanner {
  readonly memory: PlacesMemory;
  private inflight?: Promise<ScanResult>;
  private last?: { at: number; value: ScanResult };
  scans = 0; // 始めた走査の数（試験で見る）
  constructor(private o: GuardOptions & { cacheMs?: number } = {}) { this.memory = o.memory ?? newPlacesMemory(); }
  private guard(): GuardOptions { return { ...this.o, memory: this.memory }; }
  scan(opts: ScanOptions): Promise<ScanResult> {
    if (this.inflight) return this.inflight;
    if (this.last && Date.now() - this.last.at < (this.o.cacheMs ?? PLACES_CACHE_MS)) return Promise.resolve(this.last.value);
    this.scans++;
    const run = scanPlaces(opts, this.guard()).then((value) => { this.last = { at: Date.now(), value }; return value; });
    this.inflight = run.finally(() => { this.inflight = undefined; });
    return this.inflight;
  }
  resolveCwds(cwds: string[], o: { roots: string[]; home?: string; platform?: NodeJS.Platform }) { return resolveCwds(cwds, o, this.guard()); }
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

// 絞らないときの README。見出しだけだと中身が分からないので、先頭の2行を1行にする
const brief = (lines: string[]): string[] => {
  if (!lines.length) return [];
  const l = lines.slice(0, 2).join(" / ");
  return [l.length > README_LINE_CHARS ? l.slice(0, README_LINE_CHARS) + "…" : l];
};

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
    const item: Place = { name: p.name, path: p.path, remote: p.remote, readme: words.length ? p.readme : brief(p.readme), lastUsedAt: used };
    const size = JSON.stringify(item).length + 1;
    if (chars + size > PLACES_MAX_CHARS) break;
    chars += size;
    places.push(item);
  }
  return { places, total: scored.length, truncated: places.length < scored.length };
}
