// teleport で運ぶもの（pack）。1つの JSON を gzip にして送る。設計は docs/superpowers/specs/2026-11-12-session-teleport-design.md
export type Entry = { type: string; uuid?: string; cwd?: unknown; [k: string]: unknown };
export type Transcript = { main: Entry[]; subagents: Array<{ subpath: string; entries: Entry[] }> };

// 作業ツリーのスナップショット。S1 は index、S2 は作業ツリー全体（未追跡を含む）。bundle は remote に無い commit だけ
export type GitPack = {
  remote: string | null; // 認証情報を消した url
  repoName: string;      // clone するときのディレクトリ名
  rel: string;           // リポジトリの中での cwd の相対パス（"" は最上位）
  branch: string | null; // null は detached HEAD
  head: string;
  index: string;         // S1
  work: string;          // S2
  ref: string;           // bundle の中の ref 名
  bundle: string;        // git bundle の base64
  dirty: boolean;
};

export type Pack = {
  v: 1;
  id: string;            // 移動先で使う id（fork のときは新しい id）
  sourceId: string;      // 移動元の id
  fork: boolean;
  from: { node: string; cwd: string; cwds: string[]; lobby: boolean };
  title?: string;
  permissionMode?: string;
  transcript: Transcript;
  git: GitPack | null;
  warnings: string[];
};

// 下見で運ぶもの（重いものを除いた pack）
export type PackMeta = Omit<Pack, "transcript" | "git"> & { git: Omit<GitPack, "bundle"> | null };

// Cloudflare の要求の本文の上限（100MB）の手前
export const PACK_MAX_BYTES = 90 * 1024 * 1024;
export const PACK_CONTENT_TYPE = "application/x-ccn-teleport+gzip";

export class PackTooLargeError extends Error {
  constructor(public bytes: number) { super(`teleport pack is too large: ${(bytes / 1024 / 1024).toFixed(1)}MB (max ${PACK_MAX_BYTES / 1024 / 1024}MB)`); this.name = "PackTooLargeError"; }
}
export class BadPackError extends Error { constructor(msg: string) { super(`bad teleport pack: ${msg}`); this.name = "BadPackError"; } }

export function encodePack(p: Pack): Uint8Array<ArrayBuffer> {
  const gz = Bun.gzipSync(new TextEncoder().encode(JSON.stringify(p)));
  if (gz.byteLength > PACK_MAX_BYTES) throw new PackTooLargeError(gz.byteLength);
  return gz as Uint8Array<ArrayBuffer>;
}

export function decodePack(buf: Uint8Array): Pack {
  if (buf.byteLength > PACK_MAX_BYTES) throw new PackTooLargeError(buf.byteLength);
  let v: unknown;
  try { v = JSON.parse(new TextDecoder().decode(Bun.gunzipSync(buf as Uint8Array<ArrayBuffer>))); } catch (e) { throw new BadPackError(e instanceof Error ? e.message : String(e)); }
  const p = v as Pack;
  if (!p || p.v !== 1 || typeof p.id !== "string" || !UUID.test(p.id) || !p.from || typeof p.from.cwd !== "string" || !p.transcript || !Array.isArray(p.transcript.main)) throw new BadPackError("unexpected shape");
  for (const s of p.transcript.subagents ?? []) if (!safeSubpath(s.subpath)) throw new BadPackError(`unsafe subpath ${s.subpath}`);
  if (p.git && (!/^[0-9a-f]{40,64}$/.test(p.git.head) || !/^[0-9a-f]{40,64}$/.test(p.git.index) || !/^[0-9a-f]{40,64}$/.test(p.git.work) || !/^refs\/ccn-teleport\/[0-9a-f-]+$/.test(p.git.ref) || !safeRel(p.git.rel))) throw new BadPackError("unexpected git fields");
  return p;
}

export const metaOf = (p: Pack): PackMeta => {
  const { transcript: _t, git, ...rest } = p;
  if (!git) return { ...rest, git: null };
  const { bundle: _b, ...g } = git;
  return { ...rest, git: g };
};

export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// サブエージェントの置き場（subagents/agent-<x>）。SDK と同じく .. と絶対パスを断る
export const safeSubpath = (s: unknown): s is string => typeof s === "string" && /^subagents\/[A-Za-z0-9._/-]+$/.test(s) && !s.split("/").includes("..");
export const safeRel = (s: unknown): s is string => typeof s === "string" && !s.startsWith("/") && !s.split("/").includes("..");
