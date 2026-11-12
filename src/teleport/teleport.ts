// 書き出し（移動元）と取り込み（移動先）。HTTP を知らない。ノード（src/api/sessions.ts）と CLI（手元へ持ってくるとき）が使う
import { existsSync, mkdirSync, realpathSync } from "node:fs";
import type { Pack } from "./pack";
import { checkExisting, readForked, readTranscript, writeTranscript, type TranscriptFns } from "./transcript";
import { apply, snapshot, type ApplyResult, type Git } from "./git";
import { resolveDest, type Dest, type PlaceDeps } from "./place";

export type TeleportDeps = { fns: TranscriptFns; git: Git; configDir: string };

const real = (p: string) => { try { return realpathSync(p); } catch { return p; } };

export async function exportPack(d: TeleportDeps, o: {
  node: string; id: string; cwd: string; lobby: boolean; fork: boolean; title?: string; permissionMode?: string; warnings?: string[];
}): Promise<Pack> {
  const warnings = [...(o.warnings ?? [])];
  const { id, transcript } = o.fork ? await readForked(d.fns, o.id) : { id: o.id, transcript: await readTranscript(d.fns, o.id) };
  let git = null;
  if (o.cwd && existsSync(o.cwd)) git = await snapshot(d.git, o.cwd, id);
  else warnings.push(`the source directory no longer exists (${o.cwd}); only the conversation is carried`);
  return {
    v: 1, id, sourceId: o.id, fork: o.fork,
    from: { node: o.node, cwd: o.cwd, cwds: [o.cwd, real(o.cwd)], lobby: o.lobby },
    title: o.title, permissionMode: o.permissionMode, transcript, git, warnings,
  };
}

export type ImportResult = { id: string; cwd: string; cloned: boolean; git: ApplyResult | null; file: string; warnings: string[] };

// 移動先の決定（clone を含む）、作業ツリーの再現、会話の置き直しの順。dest があれば下見の結果を使う
export async function importPack(d: TeleportDeps & { place: PlaceDeps }, pack: Pack, o: { cwd?: string; dest?: Dest } = {}): Promise<ImportResult> {
  const dest = o.dest ?? await resolveDest({ id: pack.id, fork: pack.fork, from: pack.from, git: pack.git }, o.cwd, d.place);
  // 同じ id の別の会話があれば、作業ツリーを触る前に止める
  await checkExisting(d.fns, pack.id, pack.transcript.main);
  const warnings = [...pack.warnings];
  let git: ApplyResult | null = null;
  if (pack.git && dest.top) {
    git = await apply(d.git, dest.top, pack.git);
    warnings.push(...git.notes);
  }
  // 移動元の cwd が空のディレクトリだったときなど、git に載らない場所は作る
  if (!existsSync(dest.cwd)) mkdirSync(dest.cwd, { recursive: true });
  const cwd = real(dest.cwd);
  const { file } = await writeTranscript(d.fns, { configDir: d.configDir, cwd, id: pack.id, transcript: pack.transcript, fromCwds: pack.from.cwds });
  return { id: pack.id, cwd, cloned: dest.cloned, git, file, warnings };
}
