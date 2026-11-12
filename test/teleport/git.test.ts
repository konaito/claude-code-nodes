// 作業ツリーの運び方を本物の git で確かめる。一時ディレクトリに remote（bare）、移動元、移動先を作る
import { test, expect, beforeEach } from "bun:test";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, chmodSync, statSync, symlinkSync, readlinkSync, mkdirSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { apply, bunGit, checkClean, describeRepo, GitError, normalizeRemote, snapshot } from "../../src/teleport/git";

const ID = "11111111-2222-3333-4444-555555555555";
let base: string, remote: string, src: string, dst: string;

const sh = async (cwd: string, ...args: string[]) => {
  const r = await bunGit(cwd, args, { GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" });
  if (r.code !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout.trim();
};
const status = (cwd: string) => sh(cwd, "status", "--porcelain=v1", "--untracked-files=all");

beforeEach(async () => {
  base = realpathSync(mkdtempSync(join(tmpdir(), "ccn-tp-git-")));
  remote = join(base, "remote.git");
  await sh(base, "init", "-q", "--bare", "-b", "main", remote);
  src = join(base, "src");
  await sh(base, "clone", "-q", remote, src);
  writeFileSync(join(src, "a.txt"), "a\n");
  writeFileSync(join(src, "b.txt"), "b\n");
  writeFileSync(join(src, "run.sh"), "echo\n");
  writeFileSync(join(src, ".gitignore"), "node_modules/\n");
  await sh(src, "add", "-A");
  await sh(src, "commit", "-q", "-m", "init");
  await sh(src, "push", "-q", "origin", "HEAD:main");
  dst = join(base, "dst");
  await sh(base, "clone", "-q", remote, dst);
});

test("normalizeRemote makes https, scp and ssh forms equal", () => {
  const want = "github.com/konaito/claude-code-nodes";
  expect(normalizeRemote("https://github.com/konaito/claude-code-nodes.git")).toBe(want);
  expect(normalizeRemote("git@github.com:konaito/claude-code-nodes.git")).toBe(want);
  expect(normalizeRemote("ssh://git@github.com/konaito/claude-code-nodes")).toBe(want);
  expect(normalizeRemote("https://GitHub.com/konaito/claude-code-nodes/")).toBe(want);
  expect(normalizeRemote(null)).toBeNull();
});

test("staged, unstaged, deleted, untracked, executable, symlink, binary and an unpushed commit arrive; ignored files do not", async () => {
  await sh(src, "checkout", "-q", "-b", "feat/x");
  writeFileSync(join(src, "c.txt"), "committed but not pushed\n");
  await sh(src, "add", "c.txt");
  await sh(src, "commit", "-q", "-m", "local");
  writeFileSync(join(src, "a.txt"), "a staged\n");
  await sh(src, "add", "a.txt");
  writeFileSync(join(src, "a.txt"), "a staged then edited\n");
  await sh(src, "rm", "-q", "--cached", "b.txt"); // 削除を stage（ファイルは残る → 未追跡）
  chmodSync(join(src, "run.sh"), 0o755);
  writeFileSync(join(src, "new.bin"), Buffer.from([0, 1, 2, 255, 0]));
  mkdirSync(join(src, "sub"));
  writeFileSync(join(src, "sub", "u.txt"), "untracked\n");
  symlinkSync("a.txt", join(src, "link"));
  mkdirSync(join(src, "node_modules"));
  writeFileSync(join(src, "node_modules", "big.js"), "ignored\n");
  const before = await status(src);

  const p = await snapshot(bunGit, join(src, "sub"), ID);
  expect(p).not.toBeNull();
  expect(p!.branch).toBe("feat/x");
  expect(p!.rel).toBe("sub");
  expect(p!.repoName).toBe("remote");
  expect(p!.dirty).toBe(true);
  // 移動元は何も変わらない（index も ref も）
  expect(await status(src)).toBe(before);
  expect(await sh(src, "for-each-ref", "refs/ccn-teleport")).toBe("");

  await checkClean(bunGit, dst);
  const r = await apply(bunGit, dst, p!);
  expect(r.branch).toBe("feat/x");
  expect(r.previous.branch).toBe("main");
  expect(await sh(dst, "rev-parse", "HEAD")).toBe(p!.head);
  expect(await sh(dst, "symbolic-ref", "--short", "HEAD")).toBe("feat/x");
  expect(await status(dst)).toBe(before);
  expect(readFileSync(join(dst, "a.txt"), "utf8")).toBe("a staged then edited\n");
  expect(await sh(dst, "show", ":a.txt")).toBe("a staged");
  expect(statSync(join(dst, "run.sh")).mode & 0o111).not.toBe(0);
  expect([...readFileSync(join(dst, "new.bin"))]).toEqual([0, 1, 2, 255, 0]);
  expect(readlinkSync(join(dst, "link"))).toBe("a.txt");
  expect(existsSync(join(dst, "node_modules"))).toBe(false);
  expect(await sh(dst, "for-each-ref", "refs/ccn-teleport")).toBe("");
});

test("a dirty destination is refused and left alone", async () => {
  writeFileSync(join(src, "a.txt"), "changed\n");
  const p = (await snapshot(bunGit, src, ID))!;
  writeFileSync(join(dst, "mine.txt"), "human work\n");
  const e = await apply(bunGit, dst, p).catch((x) => x);
  expect(e).toBeInstanceOf(GitError);
  expect((e as GitError).code).toBe("dirty");
  expect(readFileSync(join(dst, "mine.txt"), "utf8")).toBe("human work\n");
  expect(readFileSync(join(dst, "a.txt"), "utf8")).toBe("a\n");
});

test("a destination branch with its own commits is refused", async () => {
  await sh(src, "checkout", "-q", "-b", "feat/y");
  writeFileSync(join(src, "s.txt"), "src\n");
  await sh(src, "add", "s.txt");
  await sh(src, "commit", "-q", "-m", "src side");
  const p = (await snapshot(bunGit, src, ID))!;
  await sh(dst, "checkout", "-q", "-b", "feat/y");
  writeFileSync(join(dst, "d.txt"), "dst\n");
  await sh(dst, "add", "d.txt");
  await sh(dst, "commit", "-q", "-m", "dst side");
  const tip = await sh(dst, "rev-parse", "HEAD");
  const e = await apply(bunGit, dst, p).catch((x) => x);
  expect((e as GitError).code).toBe("diverged");
  expect(await sh(dst, "rev-parse", "feat/y")).toBe(tip);
});

test("a destination branch behind the source is fast-forwarded", async () => {
  await sh(dst, "checkout", "-q", "-b", "feat/z");
  await sh(dst, "checkout", "-q", "main");
  await sh(src, "checkout", "-q", "-b", "feat/z");
  writeFileSync(join(src, "z.txt"), "z\n");
  await sh(src, "add", "z.txt");
  await sh(src, "commit", "-q", "-m", "ahead");
  const p = (await snapshot(bunGit, src, ID))!;
  await apply(bunGit, dst, p);
  expect(await sh(dst, "rev-parse", "feat/z")).toBe(p.head);
  expect(await status(dst)).toBe("");
});

test("missing prerequisite commits are reported before anything changes", async () => {
  // 移動元の remote 追跡にあって、移動先の remote には無い commit（remote から消えたもの）を前提にする
  writeFileSync(join(src, "p.txt"), "pushed then gone\n");
  await sh(src, "add", "p.txt");
  await sh(src, "commit", "-q", "-m", "p");
  await sh(src, "push", "-q", "origin", "HEAD:refs/heads/tmp");
  await sh(src, "fetch", "-q", "origin");
  await sh(remote, "update-ref", "-d", "refs/heads/tmp");
  const p = (await snapshot(bunGit, src, ID))!;
  const head = await sh(dst, "rev-parse", "HEAD");
  const e = await apply(bunGit, dst, p).catch((x) => x);
  expect((e as GitError).code).toBe("missing_commits");
  expect(await sh(dst, "rev-parse", "HEAD")).toBe(head);
});

test("detached HEAD stays detached", async () => {
  await sh(src, "checkout", "-q", "--detach", "HEAD");
  const p = (await snapshot(bunGit, src, ID))!;
  expect(p.branch).toBeNull();
  await apply(bunGit, dst, p);
  const r = await bunGit(dst, ["symbolic-ref", "-q", "HEAD"]);
  expect(r.code).not.toBe(0);
});

test("describeRepo gives remote, repo name and relative path without bundling", async () => {
  mkdirSync(join(src, "deep"));
  const d = await describeRepo(bunGit, join(src, "deep"));
  expect(d).toEqual({ remote, repoName: "remote", rel: "deep", branch: "main" });
  expect(await describeRepo(bunGit, base)).toBeNull();
});
