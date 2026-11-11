import { test, expect } from "bun:test";
import { linkSkill, type FsOps } from "../../src/join/skill-links";

function fakeFs(existing: Record<string, string | "dir" | { link: string }>) {
  const ops: string[] = [];
  const files = { ...existing };
  const fs: FsOps = {
    exists: (p) => p in files,
    isSymlinkTo: (p, t) => { const v = files[p]; return typeof v === "object" && v.link === t; },
    readText: (p) => { const v = files[p]; return typeof v === "string" ? v : undefined; },
    writeText: (p, text) => { ops.push(`write ${p}`); files[p] = text; },
    mkdir: (p) => { ops.push(`mkdir ${p}`); files[p] = "dir"; },
    rename: (a, b) => { ops.push(`rename ${a} ${b}`); files[b] = files[a]!; delete files[a]; },
    symlink: (t, p) => { ops.push(`symlink ${t} ${p}`); files[p] = { link: t }; },
    rm: (p) => { ops.push(`rm ${p}`); delete files[p]; },
    copyDir: (a, b) => { ops.push(`copy ${a} ${b}`); files[b] = "dir"; },
  };
  return { fs, ops, files };
}
const o = { home: "/h", appDir: "/h/.local/share/cc/app", configDir: "/h/.config/cc", now: new Date("2026-11-06T12:34:00") };

test("linkSkill moves an old real skill aside, links both places and copies child.md", () => {
  const f = fakeFs({ "/h/.agents/skills/ccn": "dir", "/h/.config/ccn/child.md": "old", "/h/.local/share/cc/app/skills/ccn/child.md": "new" });
  linkSkill(o, f.fs);
  expect(f.ops).toEqual([
    "rename /h/.agents/skills/ccn /h/.agents/skills/ccn.old-20261106-1234",
    "mkdir /h/.agents/skills",
    "symlink /h/.local/share/cc/app/skills/ccn /h/.agents/skills/ccn",
    "mkdir /h/.claude/skills",
    "symlink ../../.agents/skills/ccn /h/.claude/skills/ccn",
    "rename /h/.config/ccn/child.md /h/.config/ccn/child.md.old-20261106-1234",
    "write /h/.config/ccn/child.md",
  ]);
  expect(f.files["/h/.config/ccn/child.md"]).toBe("new");
});

test("linkSkill is idempotent when everything is already in place", () => {
  const f = fakeFs({ "/h/.agents/skills/ccn": { link: "/h/.local/share/cc/app/skills/ccn" }, "/h/.claude/skills/ccn": { link: "../../.agents/skills/ccn" }, "/h/.config/ccn/child.md": "same", "/h/.local/share/cc/app/skills/ccn/child.md": "same" });
  linkSkill(o, f.fs);
  expect(f.ops).toEqual([]);
});
