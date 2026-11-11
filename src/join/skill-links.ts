// スキル（SKILL_NAME）と child.md を、実行物の中の正本に向ける。~/.agents/skills が正本、~/.claude/skills は相対リンク、child.md は複製（CLAUDE.md が @ で読む）
import { cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { childMdDirOf, SKILL_NAME } from "../names";

export type FsOps = {
  exists(p: string): boolean;
  isSymlinkTo(p: string, target: string): boolean;
  readText(p: string): string | undefined;
  writeText(p: string, text: string): void;
  mkdir(p: string): void;
  rename(from: string, to: string): void;
  symlink(target: string, path: string): void;
  rm(p: string): void;
  copyDir(from: string, to: string): void;
};

export const realFs: FsOps = {
  exists: (p) => { try { lstatSync(p); return true; } catch { return false; } },
  isSymlinkTo: (p, target) => { try { return lstatSync(p).isSymbolicLink() && readlinkSync(p) === target; } catch { return false; } },
  readText: (p) => { try { return readFileSync(p, "utf8"); } catch { return undefined; } },
  writeText: (p, text) => { mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, text); },
  mkdir: (p) => mkdirSync(p, { recursive: true }),
  rename: (from, to) => renameSync(from, to),
  symlink: (target, path) => symlinkSync(target, path),
  rm: (p) => rmSync(p, { recursive: true, force: true }),
  copyDir: (from, to) => { if (existsSync(to)) rmSync(to, { recursive: true, force: true }); mkdirSync(dirname(to), { recursive: true }); cpSync(from, to, { recursive: true }); },
};

const stamp = (d: Date) => `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}-${String(d.getHours()).padStart(2, "0")}${String(d.getMinutes()).padStart(2, "0")}`;

export function linkSkill(o: { home: string; appDir: string; configDir: string; now: Date }, fs: FsOps = realFs): void {
  const target = join(o.appDir, "skills", SKILL_NAME);
  const agents = join(o.home, ".agents", "skills", SKILL_NAME);
  const suffix = `.old-${stamp(o.now)}`;
  if (fs.exists(agents) && !fs.isSymlinkTo(agents, target)) fs.rename(agents, agents + suffix);
  if (!fs.exists(agents)) { if (!fs.exists(dirname(agents))) fs.mkdir(dirname(agents)); fs.symlink(target, agents); }
  const claude = join(o.home, ".claude", "skills", SKILL_NAME);
  if (!fs.exists(claude)) { if (!fs.exists(dirname(claude))) fs.mkdir(dirname(claude)); fs.symlink(`../../.agents/skills/${SKILL_NAME}`, claude); }
  const src = fs.readText(join(target, "child.md"));
  if (src === undefined) return;
  const child = join(childMdDirOf(o.home), "child.md");
  const cur = fs.readText(child);
  if (cur === src) return;
  if (cur !== undefined) fs.rename(child, child + suffix);
  fs.writeText(child, src);
}
