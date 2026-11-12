// 会話の読み出しと置き直し。読むのは SDK の importSessionToStore（公式）だけで、行の中身は解析しない。
// 書くのは移動先だけで、SDK に置き場を指定して書く関数が無いため直接書く。書き方は SDK が resume 用の一時ファイルを作る処理と同じにし、
// 書いた直後に getSessionInfo で SDK から見えるかを確かめる（符号の規則が変わっても誤った場所に黙って置かないため）
import type { importSessionToStore, forkSession, deleteSession, getSessionInfo, SessionKey, SessionStoreEntry } from "@anthropic-ai/claude-agent-sdk";
import { copyFileSync, existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { Entry, Transcript } from "./pack";
import { safeSubpath } from "./pack";

export type TranscriptFns = {
  importSessionToStore: typeof importSessionToStore;
  forkSession: typeof forkSession;
  deleteSession: typeof deleteSession;
  getSessionInfo: typeof getSessionInfo;
};

export class NoTranscriptError extends Error { constructor(id: string) { super(`no conversation recorded for ${id}`); this.name = "NoTranscriptError"; } }
export class IdConflictError extends Error { constructor(msg: string) { super(msg); this.name = "IdConflictError"; } }

// 会話をまるごと読む（本体とサブエージェント）。dir は省く（cwd が途中で変わったセッションも、SDK が全部の置き場から探す）
export async function readTranscript(fns: TranscriptFns, id: string): Promise<Transcript> {
  const main: Entry[] = [];
  const subs = new Map<string, Entry[]>();
  const store = {
    async append(k: SessionKey, entries: SessionStoreEntry[]) {
      if (!k.subpath) main.push(...(entries as Entry[]));
      else { const list = subs.get(k.subpath) ?? []; list.push(...(entries as Entry[])); subs.set(k.subpath, list); }
    },
    async load() { return null; },
  };
  try { await fns.importSessionToStore(id, store); } catch { throw new NoTranscriptError(id); }
  if (!main.length) throw new NoTranscriptError(id);
  return { main, subagents: [...subs].filter(([p]) => safeSubpath(p)).map(([subpath, entries]) => ({ subpath, entries })) };
}

// fork。SDK の forkSession で移動元に別 id の写しを作って読み、写しは消す（id と uuid の付け替えを自分で書かない）
export async function readForked(fns: TranscriptFns, id: string): Promise<{ id: string; transcript: Transcript }> {
  const { sessionId } = await fns.forkSession(id);
  try { return { id: sessionId, transcript: await readTranscript(fns, sessionId) }; }
  finally { await fns.deleteSession(sessionId).catch(() => {}); }
}

// 各行の cwd だけを移動先に合わせる。移動元の cwd（とその realpath）で始まる値を置き換え、それ以外の行と本文は触らない
export function rewriteCwd(entries: Entry[], from: string[], to: string): Entry[] {
  const roots = [...new Set(from.filter(Boolean))].sort((a, b) => b.length - a.length);
  return entries.map((e) => {
    if (typeof e.cwd !== "string") return e;
    const cwd = e.cwd;
    const hit = roots.find((r) => cwd === r || cwd.startsWith(r + "/"));
    return hit ? { ...e, cwd: to + cwd.slice(hit.length) } : e;
  });
}

// Claude Code の設定ディレクトリ。SDK と同じく CLAUDE_CONFIG_DIR、無ければ ~/.claude
export function claudeConfigDir(env: Record<string, string | undefined> = process.env, home = homedir()): string {
  return (env.CLAUDE_CONFIG_DIR?.trim() || join(home, ".claude")).normalize("NFC");
}

// cwd の置き場の名前。SDK（sdk.mjs の ju と nl、0.3.318）と同じく英数字以外を - にし、200字を超えたら djb2 の36進を足す
const MAX = 200;
function djb2(s: string): string {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = ((h << 5) - h + s.charCodeAt(i)) | 0;
  return Math.abs(h).toString(36);
}
export function projectDirName(cwd: string, platform: NodeJS.Platform = process.platform): string {
  const p = platform === "darwin" ? cwd.normalize("NFC") : cwd;
  const s = p.replace(/[^a-zA-Z0-9]/g, "-");
  return s.length <= MAX ? s : `${s.slice(0, MAX)}-${djb2(p)}`;
}

const jsonl = (entries: Entry[]) => entries.map((e) => JSON.stringify(e)).join("\n") + "\n";
function writeAtomic(path: string, text: string, mode = 0o600) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.ccn-tmp-${process.pid}`;
  writeFileSync(tmp, text, { mode });
  renameSync(tmp, path);
}

// 移動先に同じ id があるかを見る。古い写し（uuid の並びが運んだ会話の先頭と一致する）なら置き換えてよい。別の会話なら止める
export async function checkExisting(fns: TranscriptFns, id: string, incoming: Entry[] | null): Promise<{ existing: false } | { existing: true; cwd: string }> {
  const info = await fns.getSessionInfo(id).catch(() => undefined);
  if (!info) return { existing: false };
  const cwd = (info as { cwd?: string }).cwd ?? "";
  if (incoming) {
    const have = (await readTranscript(fns, id).catch(() => ({ main: [] as Entry[] }))).main.map((e) => e.uuid).filter(Boolean);
    const next = incoming.map((e) => e.uuid).filter(Boolean);
    const prefix = have.length <= next.length && have.every((u, i) => u === next[i]);
    if (!prefix) throw new IdConflictError(`a different conversation with id ${id} already exists here (${cwd || "unknown cwd"})`);
  }
  return { existing: true, cwd };
}

// 会話を移動先の cwd の置き場に書く。サブエージェントは <id>/<subpath>.jsonl、agent_metadata は <id>/<subpath>.meta.json（SDK と同じ形）
export async function writeTranscript(fns: TranscriptFns, o: { configDir: string; cwd: string; id: string; transcript: Transcript; fromCwds: string[] }): Promise<{ file: string }> {
  const prev = await checkExisting(fns, o.id, o.transcript.main);
  // 別の cwd の置き場に古い写しがあれば、SDK に消させてから書く（同じ id が2か所にあると SDK がどちらを読むか決まらない）
  if (prev.existing && prev.cwd && prev.cwd !== o.cwd) await fns.deleteSession(o.id, { dir: prev.cwd });
  const dir = join(o.configDir, "projects", projectDirName(o.cwd));
  const file = join(dir, `${o.id}.jsonl`);
  const written: string[] = [];
  // 同じ置き場の古い写しは、確かめ終わるまで控えを残す
  const bak = existsSync(file) ? `${file}.ccn-bak-${process.pid}` : undefined;
  if (bak) copyFileSync(file, bak);
  try {
    writeAtomic(file, jsonl(rewriteCwd(o.transcript.main, o.fromCwds, o.cwd)));
    written.push(file);
    for (const s of o.transcript.subagents) {
      if (!safeSubpath(s.subpath)) continue;
      const meta = s.entries.filter((e) => e.type === "agent_metadata");
      const rest = rewriteCwd(s.entries.filter((e) => e.type !== "agent_metadata"), o.fromCwds, o.cwd);
      const base = join(dir, o.id, s.subpath);
      if (rest.length) { writeAtomic(`${base}.jsonl`, jsonl(rest)); written.push(`${base}.jsonl`); }
      if (meta.length) { const { type: _t, ...m } = meta[meta.length - 1]!; writeAtomic(`${base}.meta.json`, JSON.stringify(m)); written.push(`${base}.meta.json`); }
    }
    const info = await fns.getSessionInfo(o.id, { dir: o.cwd }).catch(() => undefined);
    if (!info) throw new Error(`the SDK does not see ${file} for cwd ${o.cwd}; the transcript layout may have changed`);
  } catch (e) {
    for (const f of written) rmSync(f, { force: true });
    if (bak) renameSync(bak, file);
    throw e;
  }
  if (bak) rmSync(bak, { force: true });
  return { file };
}
