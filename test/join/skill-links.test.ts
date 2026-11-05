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
  const f = fakeFs({ "/h/.agents/skills/session-inbox": "dir", "/h/.config/session-inbox/child.md": "old", "/h/.local/share/cc/app/skills/session-inbox/child.md": "new" });
  linkSkill(o, f.fs);
  expect(f.ops).toEqual([
    "rename /h/.agents/skills/session-inbox /h/.agents/skills/session-inbox.old-20261106-1234",
    "mkdir /h/.agents/skills",
    "symlink /h/.local/share/cc/app/skills/session-inbox /h/.agents/skills/session-inbox",
    "mkdir /h/.claude/skills",
    "symlink ../../.agents/skills/session-inbox /h/.claude/skills/session-inbox",
    "rename /h/.config/session-inbox/child.md /h/.config/session-inbox/child.md.old-20261106-1234",
    "write /h/.config/session-inbox/child.md",
  ]);
  expect(f.files["/h/.config/session-inbox/child.md"]).toBe("new");
});

test("linkSkill is idempotent when everything is already in place", () => {
  const f = fakeFs({ "/h/.agents/skills/session-inbox": { link: "/h/.local/share/cc/app/skills/session-inbox" }, "/h/.claude/skills/session-inbox": { link: "../../.agents/skills/session-inbox" }, "/h/.config/session-inbox/child.md": "same", "/h/.local/share/cc/app/skills/session-inbox/child.md": "same" });
  linkSkill(o, f.fs);
  expect(f.ops).toEqual([]);
});
