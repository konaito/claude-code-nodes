// 移動先のディレクトリを決める。ホームの場所が機械ごとに違うので、移動先の側で remote から探す（仕様3）。
// --cwd があればそれ、無ければ places の remote が一致するもの、それも無ければ <home>/Documents/<リポジトリ名> に clone、決まらなければ止める
import { existsSync, mkdirSync, realpathSync, statSync } from "node:fs";
import { basename, join, resolve, sep } from "node:path";
import type { RepoInfo } from "./git";
import { checkClean, clone, normalizeRemote, remoteMatches, topOf, type Git } from "./git";

// 下見に要るもの。pack の一部（PackMeta）もこの形を満たす
export type CheckInput = { id?: string; fork?: boolean; from: { node: string; cwd: string; lobby: boolean }; git: RepoInfo | null };

export type PlaceDeps = {
  git: Git;
  home: string;
  roots: string[];
  lobby: string;
  // 移動先の places（src/lobby/places.ts）。path と remote だけを使う
  places: () => Promise<Array<{ path: string; remote: string | null }>>;
};
export type Dest = { cwd: string; top: string | null; cloned: boolean };

export class PlaceError extends Error {
  constructor(msg: string, public code: "no_place" | "ambiguous" | "outside_roots" | "remote_mismatch" | "exists" = "no_place", public detail?: unknown) { super(msg); this.name = "PlaceError"; }
}

const real = (p: string) => { try { return realpathSync(p); } catch { return resolve(p); } };
const under = (p: string, roots: string[]) => roots.map(real).some((r) => p === r || p.startsWith(r + sep));
const isDir = (p: string) => { try { return statSync(p).isDirectory(); } catch { return false; } };

// 下見の中で clone まで行う（新しいディレクトリを作るだけで、既存の作業を消さないため）。作業ツリーがきれいかも見る
export async function resolveDest(meta: CheckInput, cwdArg: string | undefined, d: PlaceDeps): Promise<Dest> {
  const g = meta.git;
  if (cwdArg) {
    if (!isDir(cwdArg)) throw new PlaceError(`--cwd does not exist here: ${cwdArg}`);
    const dir = real(cwdArg);
    if (!under(dir, d.roots)) throw new PlaceError(`--cwd is outside roots (${d.roots.join(", ")}): ${dir}`, "outside_roots");
    if (!g) return { cwd: dir, top: null, cloned: false };
    const top = await topOf(d.git, dir);
    if (!top) throw new PlaceError(`--cwd is not a git repository: ${dir}`);
    if (!(await remoteMatches(d.git, top, g.remote))) throw new PlaceError(`--cwd has no remote matching ${g.remote}: ${top}`, "remote_mismatch");
    await checkClean(d.git, top);
    return { cwd: join(top, g.rel), top, cloned: false };
  }
  if (!g) {
    if (meta.from.lobby) return { cwd: real(d.lobby), top: null, cloned: false };
    throw new PlaceError(`the source directory is not a git repository (${meta.from.cwd}); pass --cwd to choose where it goes`);
  }
  if (!g.remote) throw new PlaceError(`the source repository has no remote to look for (${meta.from.cwd}); pass --cwd`);
  const want = normalizeRemote(g.remote);
  let hits = (await d.places()).filter((p) => normalizeRemote(p.remote) === want);
  if (hits.length > 1) {
    const named = hits.filter((p) => basename(p.path) === g.repoName);
    if (named.length === 1) hits = named;
    else throw new PlaceError(`several places here have remote ${g.remote}; pass --cwd: ${hits.map((p) => p.path).join(", ")}`, "ambiguous", hits.map((p) => p.path));
  }
  let top: string;
  let cloned = false;
  if (hits.length === 1) {
    top = real(hits[0]!.path);
  } else {
    // ~/Documents が無い機械（Linux）では作る。決まりを機械ごとに変えないため。空のディレクトリを1つ作るだけで何も消えない
    const docs = join(d.home, "Documents");
    const target = join(docs, g.repoName);
    if (!under(resolve(target), d.roots)) throw new PlaceError(`${target} is outside roots (${d.roots.join(", ")}); pass --cwd`, "outside_roots");
    // places に出ていなくても（走査の打ち切りや10秒の覚え）、remote が一致するリポジトリが既にあればそれを使う
    const there = existsSync(target) ? await topOf(d.git, target) : null;
    if (there && real(there) === real(target) && (await remoteMatches(d.git, there, g.remote))) {
      top = real(target);
    } else {
      if (existsSync(target)) throw new PlaceError(`${target} exists but its remote does not match ${g.remote}; pass --cwd`, "exists");
      mkdirSync(docs, { recursive: true });
      await clone(d.git, g.remote, target);
      top = real(target);
      cloned = true;
    }
  }
  if (!(await topOf(d.git, top))) throw new PlaceError(`${top} is not a git repository`);
  await checkClean(d.git, top);
  return { cwd: join(top, g.rel), top, cloned };
}
