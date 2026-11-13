// 会話の置き直しを本物の SDK（importSessionToStore、getSessionInfo、forkSession、deleteSession）で確かめる。claude は使わない。
// SDK は CLAUDE_CONFIG_DIR を呼んだときに読むので、一時の設定ディレクトリに差し替えて、終わったら戻す
import { test, expect, beforeAll, afterAll } from "bun:test";
import { importSessionToStore, forkSession, deleteSession, getSessionInfo, getSessionMessages } from "@anthropic-ai/claude-agent-sdk";
import { mkdtempSync, mkdirSync, readFileSync, existsSync, realpathSync, writeFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkExisting, claudeConfigDir, IdConflictError, projectDirName, readForked, readTranscript, rewriteCwd, writeTranscript } from "../../src/teleport/transcript";
import type { Entry } from "../../src/teleport/pack";

const fns = { importSessionToStore, forkSession, deleteSession, getSessionInfo };
const ID = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
let cfg: string, base: string, saved: string | undefined;

beforeAll(() => {
  saved = process.env.CLAUDE_CONFIG_DIR;
  base = realpathSync(mkdtempSync(join(tmpdir(), "ccn-tp-tr-")));
  cfg = join(base, "claude");
  mkdirSync(join(cfg, "projects"), { recursive: true });
  process.env.CLAUDE_CONFIG_DIR = cfg;
});
afterAll(() => { if (saved === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = saved; });

const conv = (id: string, cwd: string, n = 2): Entry[] => {
  const out: Entry[] = [];
  let parent: string | null = null;
  for (let i = 0; i < n; i++) {
    const uuid = `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`;
    const role = i % 2 ? "assistant" : "user";
    out.push({ type: role, uuid, parentUuid: parent, sessionId: id, cwd, timestamp: new Date(1_700_000_000_000 + i * 1000).toISOString(), isSidechain: false, userType: "external", version: "2.1.322",
      message: role === "user" ? { role, content: i === 0 ? "合言葉は みかん42" : `turn ${i}` } : { role, id: `msg_${i}`, type: "message", model: "claude-opus-5-5", content: [{ type: "text", text: `ok ${i}` }], stop_reason: "end_turn", usage: { input_tokens: 1, output_tokens: 1 } } });
    parent = uuid;
  }
  out.push({ type: "custom-title", customTitle: "テスト", sessionId: id });
  return out;
};

test("projectDirName matches the SDK for short, long and non-ASCII paths (checked by getSessionInfo)", async () => {
  const long = join(base, "x".repeat(230));
  const ja = join(base, "日本語の場所");
  for (const [i, cwd] of [join(base, "dst-a"), long, ja].entries()) {
    mkdirSync(cwd, { recursive: true });
    const id = `aaaaaaaa-bbbb-4ccc-8ddd-00000000000${i}`;
    const dir = join(cfg, "projects", projectDirName(cwd));
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${id}.jsonl`), conv(id, cwd).map((e) => JSON.stringify(e)).join("\n") + "\n");
    const info = await getSessionInfo(id, { dir: cwd });
    expect(info?.sessionId).toBe(id);
  }
  expect(projectDirName(long).length).toBeGreaterThan(200);
});

test("write then read round-trips, rewrites only cwd, and the SDK sees it", async () => {
  const from = "/Users/someone/Documents/proj";
  const to = join(base, "proj-dst");
  mkdirSync(to);
  const main = conv(ID, from, 4);
  main[1] = { ...main[1]!, cwd: "/elsewhere" };
  const sub = [{ type: "user", uuid: "s1", parentUuid: null, sessionId: ID, cwd: from + "/x", isSidechain: true, message: { role: "user", content: "sub" } }, { type: "agent_metadata", agentType: "web-fetch", toolUseId: "t1" }] as Entry[];
  const { file } = await writeTranscript(fns, { configDir: claudeConfigDir(), cwd: to, id: ID, transcript: { main, subagents: [{ subpath: "subagents/agent-abc", entries: sub }] }, fromCwds: [from] });
  expect(file).toBe(join(cfg, "projects", projectDirName(to), `${ID}.jsonl`));
  const lines = readFileSync(file, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  expect(lines.map((l) => l.cwd)).toEqual([to, "/elsewhere", to, to, undefined]);
  expect(lines[0].message.content).toBe("合言葉は みかん42");
  const subDir = join(cfg, "projects", projectDirName(to), ID, "subagents");
  expect(readdirSync(subDir).sort()).toEqual(["agent-abc.jsonl", "agent-abc.meta.json"]);
  expect(JSON.parse(readFileSync(join(subDir, "agent-abc.meta.json"), "utf8"))).toEqual({ agentType: "web-fetch", toolUseId: "t1" });
  expect((await getSessionInfo(ID, { dir: to }))?.cwd).toBe(to);
  expect((await getSessionMessages(ID, { dir: to })).length).toBe(4);
  const back = await readTranscript(fns, ID);
  expect(back.main.length).toBe(main.length);
  expect(back.subagents.map((s) => s.subpath)).toEqual(["subagents/agent-abc"]);
});

test("an older copy of the same conversation is replaced, a different one is refused", async () => {
  const id = "aaaaaaaa-bbbb-4ccc-8ddd-000000000010";
  const a = join(base, "rt-a");
  const b = join(base, "rt-b");
  mkdirSync(a); mkdirSync(b);
  const short = conv(id, a, 2);
  await writeTranscript(fns, { configDir: cfg, cwd: a, id, transcript: { main: short, subagents: [] }, fromCwds: [a] });
  // 往復して戻ってきた（先頭が一致する長い会話）→ 置き換え、古い置き場は消える
  const longer = conv(id, a, 4);
  await writeTranscript(fns, { configDir: cfg, cwd: b, id, transcript: { main: longer, subagents: [] }, fromCwds: [a] });
  expect(existsSync(join(cfg, "projects", projectDirName(a), `${id}.jsonl`))).toBe(false);
  expect((await getSessionMessages(id, { dir: b })).length).toBe(4);
  // 別の会話（uuid が違う）→ 止める
  const other = conv(id, b, 2).map((e) => (e.uuid ? { ...e, uuid: e.uuid.replace(/^0/, "f") } : e));
  await expect(checkExisting(fns, id, other)).rejects.toBeInstanceOf(IdConflictError);
  await expect(writeTranscript(fns, { configDir: cfg, cwd: b, id, transcript: { main: other, subagents: [] }, fromCwds: [b] })).rejects.toBeInstanceOf(IdConflictError);
  expect((await getSessionMessages(id, { dir: b })).length).toBe(4);
});

test("fork gives a new id and leaves no copy behind at the source", async () => {
  const id = "aaaaaaaa-bbbb-4ccc-8ddd-000000000020";
  const cwd = join(base, "fork-src");
  mkdirSync(cwd);
  await writeTranscript(fns, { configDir: cfg, cwd, id, transcript: { main: conv(id, cwd, 2), subagents: [] }, fromCwds: [cwd] });
  const before = readdirSync(join(cfg, "projects", projectDirName(cwd))).sort();
  const f = await readForked(fns, id);
  expect(f.id).not.toBe(id);
  expect(f.transcript.main.filter((e) => e.type === "user" || e.type === "assistant").length).toBe(2);
  expect(f.transcript.main.every((e) => e.sessionId === undefined || e.sessionId === f.id)).toBe(true);
  expect(readdirSync(join(cfg, "projects", projectDirName(cwd))).sort()).toEqual(before);
});

test("rewriteCwd maps the longest matching root and leaves other paths", () => {
  const e = [{ type: "user", cwd: "/a/b/c" }, { type: "user", cwd: "/a/bc" }, { type: "x" }] as Entry[];
  expect(rewriteCwd(e, ["/a", "/a/b"], "/z").map((x) => x.cwd)).toEqual(["/z/c", "/z/bc", undefined]);
});

test("a missing session reads as an error", async () => {
  await expect(readTranscript(fns, "aaaaaaaa-bbbb-4ccc-8ddd-0000000000ff")).rejects.toThrow("no conversation");
});
