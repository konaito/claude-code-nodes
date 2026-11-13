// 作業ツリーのスナップショットと再現。git stash は worktree 間で共有されるので使わない。
// 移動元: index を S1、作業ツリー全体（未追跡を含み ignore は除く）を S2 として commit-tree で作り、remote に無い commit だけを bundle にする。
// 移動先: きれいな作業ツリーで、ブランチを合わせ、read-tree で作業ツリーを S2、index を S1 にする。reset --hard、clean、checkout -f は使わない
import { mkdtempSync, readFileSync, rmSync, writeFileSync, copyFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { realpathSync } from "node:fs";
import type { GitPack } from "./pack";
import { cleanRemote } from "../lobby/places";

export type GitResult = { code: number; stdout: string; stderr: string };
export type Git = (cwd: string, args: string[], env?: Record<string, string>) => Promise<GitResult>;

export const bunGit: Git = async (cwd, args, env) => {
  const p = Bun.spawn(["git", ...args], {
    cwd, stdout: "pipe", stderr: "pipe", stdin: "ignore",
    // 対話の認証を待たない（ノードの裏で止まらないように）
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_ASKPASS: "", SSH_ASKPASS: "", ...env },
  });
  const [stdout, stderr, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  return { code, stdout, stderr };
};

export class GitError extends Error {
  constructor(msg: string, public code: "not_repo" | "dirty" | "busy" | "diverged" | "missing_commits" | "branch_in_use" | "failed" | "no_commits" = "failed", public detail?: unknown) {
    super(msg); this.name = "GitError";
  }
}

async function must(git: Git, cwd: string, args: string[], env?: Record<string, string>): Promise<string> {
  const r = await git(cwd, args, env);
  if (r.code !== 0) throw new GitError(`git ${args.join(" ")} failed: ${(r.stderr || r.stdout).trim().slice(0, 400)}`);
  return r.stdout.trim();
}
const ok = async (git: Git, cwd: string, args: string[]) => (await git(cwd, args)).code === 0;
// commit-tree に要る名前。利用者の設定が無い機械でも作れるように固定する
const IDENT = { GIT_AUTHOR_NAME: "ccn teleport", GIT_AUTHOR_EMAIL: "ccn@localhost", GIT_COMMITTER_NAME: "ccn teleport", GIT_COMMITTER_EMAIL: "ccn@localhost" };

// remote の url を比べる形にそろえる。https://github.com/a/b.git、git@github.com:a/b、ssh://git@github.com/a/b → github.com/a/b
export function normalizeRemote(url: string | null | undefined): string | null {
  if (!url) return null;
  let u = url.trim();
  const scp = u.match(/^[^@/]+@([^:/]+):(.+)$/); // git@host:path
  if (scp) u = `${scp[1]}/${scp[2]}`;
  else u = u.replace(/^[a-z+]+:\/\//i, "").replace(/^[^@/]*@/, "");
  u = u.replace(/:\d+\//, "/").replace(/\/+$/, "").replace(/\.git$/i, "");
  const [host, ...rest] = u.split("/");
  return [host!.toLowerCase(), ...rest].join("/");
}
export const repoNameOf = (remote: string | null, top: string) => {
  const n = normalizeRemote(remote);
  return (n ? n.split("/").pop() : "") || basename(top);
};

export async function topOf(git: Git, cwd: string): Promise<string | null> {
  const r = await git(cwd, ["rev-parse", "--show-toplevel"]);
  return r.code === 0 && r.stdout.trim() ? realpathSync(r.stdout.trim()) : null;
}

async function remoteOf(git: Git, top: string, branch: string | null): Promise<{ name: string; url: string } | null> {
  const names = (await git(top, ["remote"])).stdout.split("\n").map((s) => s.trim()).filter(Boolean);
  if (!names.length) return null;
  const up = branch ? (await git(top, ["config", `branch.${branch}.remote`])).stdout.trim() : "";
  const name = names.includes(up) ? up : names.includes("origin") ? "origin" : names[0]!;
  const url = (await git(top, ["remote", "get-url", name])).stdout.trim();
  return url ? { name, url: cleanRemote(url) } : null;
}

// 移動元のスナップショット。cwd が git でなければ null
export async function snapshot(git: Git, cwd: string, id: string): Promise<GitPack | null> {
  const top = await topOf(git, cwd);
  if (!top) return null;
  const rel = relative(top, realpathSync(cwd));
  const head = (await git(top, ["rev-parse", "--verify", "-q", "HEAD^{commit}"])).stdout.trim();
  if (!head) throw new GitError("the source repository has no commits", "no_commits");
  const sym = await git(top, ["symbolic-ref", "-q", "--short", "HEAD"]);
  const branch = sym.code === 0 ? sym.stdout.trim() || null : null;
  const remote = await remoteOf(git, top, branch);
  const headTree = await must(git, top, ["rev-parse", "HEAD^{tree}"]);
  const indexTree = (await git(top, ["write-tree"])).stdout.trim();
  if (!indexTree) throw new GitError("the source index has unresolved conflicts", "busy");
  const tmp = mkdtempSync(join(tmpdir(), "ccn-teleport-"));
  try {
    // 一時の index に今の index を写し、作業ツリー全体を入れる。本物の index は触らない
    const realIndex = await must(git, top, ["rev-parse", "--path-format=absolute", "--git-path", "index"]);
    const idx = join(tmp, "index");
    if (existsSync(realIndex)) copyFileSync(realIndex, idx);
    const env = { GIT_INDEX_FILE: idx };
    await must(git, top, ["add", "-A", "--", "."], env);
    const workTree = await must(git, top, ["write-tree"], env);
    const s1 = await must(git, top, ["commit-tree", indexTree, "-p", head, "-m", "ccn teleport: index"], IDENT);
    const s2 = await must(git, top, ["commit-tree", workTree, "-p", s1, "-m", "ccn teleport: worktree"], IDENT);
    const ref = `refs/ccn-teleport/${id}`;
    await must(git, top, ["update-ref", ref, s2]);
    const file = join(tmp, "pack.bundle");
    try {
      // remote に無い commit だけを束ねる。remote が無ければ全部
      await must(git, top, ["bundle", "create", "-q", file, ref, "--not", "--remotes"]);
    } finally {
      await git(top, ["update-ref", "-d", ref]);
    }
    return {
      remote: remote?.url ?? null, repoName: repoNameOf(remote?.url ?? null, mainTopOf(top, await must(git, top, ["rev-parse", "--path-format=absolute", "--git-common-dir"]))),
      rel, branch, head, index: s1, work: s2, ref, bundle: readFileSync(file).toString("base64"),
      dirty: indexTree !== headTree || workTree !== indexTree,
    };
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}
// worktree の中でも、本体のディレクトリ名を返す（common dir が <本体>/.git のとき）
function mainTopOf(top: string, commonDir: string): string {
  return basename(commonDir) === ".git" ? dirname(commonDir) : top;
}

// 移動先の下見。きれいな作業ツリーで、merge や rebase の途中でないか
export async function checkClean(git: Git, top: string): Promise<void> {
  const st = await git(top, ["status", "--porcelain=v1", "--untracked-files=all"]);
  if (st.code !== 0) throw new GitError(`git status failed in ${top}: ${st.stderr.trim()}`, "not_repo");
  const lines = st.stdout.split("\n").filter(Boolean);
  if (lines.length) throw new GitError(`the destination working tree has changes (${lines.length} files). Commit, stash or move them first: ${top}`, "dirty", { top, files: lines.slice(0, 20) });
  for (const f of ["MERGE_HEAD", "CHERRY_PICK_HEAD", "REVERT_HEAD", "rebase-merge", "rebase-apply", "BISECT_LOG"]) {
    const p = (await git(top, ["rev-parse", "--path-format=absolute", "--git-path", f])).stdout.trim();
    if (p && existsSync(p)) throw new GitError(`the destination repository is in the middle of an operation (${f}): ${top}`, "busy");
  }
}

export async function remoteMatches(git: Git, top: string, remote: string | null): Promise<boolean> {
  if (!remote) return true;
  const want = normalizeRemote(remote);
  const names = (await git(top, ["remote"])).stdout.split("\n").map((s) => s.trim()).filter(Boolean);
  for (const n of names) if (normalizeRemote((await git(top, ["remote", "get-url", n])).stdout.trim()) === want) return true;
  return false;
}

export type ApplyResult = { top: string; branch: string | null; head: string; previous: { branch: string | null; head: string | null }; notes: string[] };

// 移動先で再現する。下見（checkClean）を済ませてから呼ぶ。ここでも汚れていれば止まる
export async function apply(git: Git, top: string, p: GitPack): Promise<ApplyResult> {
  await checkClean(git, top);
  const notes: string[] = [];
  const prevSym = await git(top, ["symbolic-ref", "-q", "--short", "HEAD"]);
  const previous = { branch: prevSym.code === 0 ? prevSym.stdout.trim() || null : null, head: (await git(top, ["rev-parse", "--verify", "-q", "HEAD"])).stdout.trim() || null };
  const tmp = mkdtempSync(join(tmpdir(), "ccn-teleport-"));
  try {
    const file = join(tmp, "pack.bundle");
    writeFileSync(file, Buffer.from(p.bundle, "base64"));
    // 前提の commit を remote から取る。取れなくても bundle がそろっていれば進める
    for (const name of (await git(top, ["remote"])).stdout.split("\n").map((s) => s.trim()).filter(Boolean)) {
      if (p.remote && normalizeRemote((await git(top, ["remote", "get-url", name])).stdout.trim()) !== normalizeRemote(p.remote)) continue;
      const f = await git(top, ["fetch", "-q", name]);
      if (f.code !== 0) notes.push(`git fetch ${name} failed: ${f.stderr.trim().slice(0, 200)}`);
    }
    const v = await git(top, ["bundle", "verify", "-q", file]);
    if (v.code !== 0) throw new GitError(`the destination lacks commits the source builds on. Push them from the source, then retry: ${v.stderr.trim().slice(0, 300)}`, "missing_commits");
    await must(git, top, ["fetch", "-q", file, `${p.ref}:${p.ref}`]);
    try {
      const work = await must(git, top, ["rev-parse", `${p.ref}^{commit}`]);
      if (work !== p.work) throw new GitError("the bundle does not match the pack");
      if (p.branch) {
        const ref = `refs/heads/${p.branch}`;
        const tip = (await git(top, ["rev-parse", "--verify", "-q", ref])).stdout.trim();
        if (tip && tip !== p.head && !(await ok(git, top, ["merge-base", "--is-ancestor", tip, p.head]))) {
          throw new GitError(`branch ${p.branch} here has commits the source does not have (${tip.slice(0, 8)} is not an ancestor of ${p.head.slice(0, 8)})`, "diverged");
        }
        const wt = (await git(top, ["worktree", "list", "--porcelain"])).stdout.split("\n\n");
        const other = wt.find((b) => b.includes(`branch ${ref}`) && !b.startsWith(`worktree ${top}\n`));
        if (other) throw new GitError(`branch ${p.branch} is checked out in another worktree here: ${other.split("\n")[0]!.replace(/^worktree /, "")}`, "branch_in_use");
        // 祖先か同じなので、-B で進めても commit は失われない。作業ツリーはきれい
        await must(git, top, ["checkout", "-q", "-B", p.branch, p.head]);
        if (!tip) {
          const remotes = (await git(top, ["for-each-ref", "--format=%(refname:short)", `refs/remotes/*/${p.branch}`])).stdout.split("\n").filter(Boolean);
          if (remotes[0]) await git(top, ["branch", "-q", `--set-upstream-to=${remotes[0]}`, p.branch]);
        }
      } else {
        await must(git, top, ["checkout", "-q", "--detach", p.head]);
      }
      // 作業ツリーを S2 にし（上書きになる未追跡があれば git が止める）、index を S1 に戻す
      await must(git, top, ["read-tree", "-m", "-u", p.head, p.work]);
      await must(git, top, ["read-tree", p.index]);
      await git(top, ["update-index", "-q", "--refresh"]);
    } finally {
      await git(top, ["update-ref", "-d", p.ref]);
    }
    return { top, branch: p.branch, head: p.head, previous, notes };
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

// clone。dir が無いことを呼び手が確かめてから呼ぶ
export async function clone(git: Git, remote: string, dir: string): Promise<void> {
  if (!isAbsolute(dir)) throw new GitError(`clone target must be absolute: ${dir}`);
  const r = await git(dirname(resolve(dir)), ["clone", "-q", remote, dir]);
  if (r.code !== 0) throw new GitError(`git clone ${remote} failed: ${r.stderr.trim().slice(0, 300)}`);
}

// 下見に使う軽い説明（bundle を作らない）。cwd が git でなければ null
export type RepoInfo = { remote: string | null; repoName: string; rel: string; branch: string | null };
export async function describeRepo(git: Git, cwd: string): Promise<RepoInfo | null> {
  if (!existsSync(cwd)) return null;
  const top = await topOf(git, cwd);
  if (!top) return null;
  const sym = await git(top, ["symbolic-ref", "-q", "--short", "HEAD"]);
  const branch = sym.code === 0 ? sym.stdout.trim() || null : null;
  const remote = await remoteOf(git, top, branch);
  const common = (await git(top, ["rev-parse", "--path-format=absolute", "--git-common-dir"])).stdout.trim();
  return { remote: remote?.url ?? null, repoName: repoNameOf(remote?.url ?? null, common ? mainTopOf(top, common) : top), rel: relative(top, realpathSync(cwd)), branch };
}
