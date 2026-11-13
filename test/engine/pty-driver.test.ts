import { test, expect } from "bun:test";
import { mkdtempSync, writeFileSync, statSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PtyDriver, childEnv, ptyArgv, type TermFrame } from "../../src/engine/pty-driver";
import { BusyError, ExitedError } from "../../src/engine/driver";
import type { RawEvent } from "../../src/engine/driver";
import type { AgentInfo } from "../../src/engine/agents";
import { fakeSpawn } from "../helpers/fake-pty";

const tmp = () => mkdtempSync(join(tmpdir(), "ccn-pty-test-"));
async function start(over: Partial<Parameters<typeof PtyDriver.start>[0]> = {}, deps: Partial<Parameters<typeof PtyDriver.start>[1]> = {}) {
  const f = fakeSpawn();
  const d = await PtyDriver.start({ cwd: "/w", ...over }, { spawn: f.spawn, hookBase: "http://127.0.0.1:9", caller: "agent:vm/abcd1234/town", claudePath: "claude", env: { PATH: "/bin", CLAUDECODE: "1", CLAUDE_CODE_SESSION_ID: "x" }, tmp: tmp(), pasteDelayMs: 0, reconcileDelayMs: 5, inputTimeoutMs: 0, ...deps });
  return { d, p: f.procs[0]!, f };
}
async function take<T>(it: AsyncIterable<T>, n: number): Promise<T[]> {
  const out: T[] = [];
  const i = it[Symbol.asyncIterator]();
  while (out.length < n) { const r = await i.next(); if (r.done) break; out.push(r.value); }
  return out;
}
const dec = (f: TermFrame) => ("b64" in f ? Buffer.from(f.b64, "base64").toString() : "");
function collect(d: PtyDriver): RawEvent[] { const evs: RawEvent[] = []; void (async () => { for await (const e of d.events()) evs.push(e); })(); return evs; }
const tick = () => new Promise((r) => setTimeout(r, 15));

test("starts claude with --session-id, a 0600 settings file holding the hooks, and the prompt as an argument", async () => {
  const { d, p } = await start({ prompt: "from local via vm\n\nhi", permissionMode: "default", model: "haiku", name: "town-1", cols: 100, rows: 30 });
  expect(p.argv[0]).toBe("claude");
  expect(p.argv.slice(1, 3)).toEqual(["--session-id", d.id]);
  const file = p.argv[p.argv.indexOf("--settings") + 1]!;
  expect(statSync(file).mode & 0o777).toBe(0o600);
  const s = JSON.parse(readFileSync(file, "utf8"));
  const h = s.hooks.PermissionRequest[0].hooks[0];
  expect(h.url).toBe(`http://127.0.0.1:9/hooks/pty/${d.id}`);
  expect(h.headers["x-ccn-hook-token"]).toBe(d.token);
  expect(Object.keys(s.hooks).sort()).toEqual(["Notification", "PermissionRequest", "PostToolUse", "PostToolUseFailure", "PreToolUse", "SessionStart", "Stop", "StopFailure", "UserPromptSubmit"]);
  // SessionStart は command の hook だけなので curl で送る。token は引数に出さず、0600 のヘッダのファイルから読む
  const ss = s.hooks.SessionStart[0].hooks[0];
  expect(ss.type).toBe("command");
  expect(ss.command).not.toContain(d.token);
  const hf = /-H @'([^']+)'/.exec(ss.command)![1]!;
  expect(statSync(hf).mode & 0o777).toBe(0o600);
  expect(readFileSync(hf, "utf8")).toBe(`x-ccn-hook-token: ${d.token}\n`);
  expect(p.argv).toContain("--permission-mode");
  expect(p.argv).toContain("--name");
  expect(p.argv.at(-1)).toBe("from local via vm\n\nhi");
  expect(p.argv.join(" ")).not.toContain(d.token); // 秘密を引数に出さない
  expect(p.size).toEqual({ cols: 100, rows: 30 });
  expect(p.env.CLAUDECODE).toBeUndefined();
  expect(p.env.CLAUDE_CODE_SESSION_ID).toBeUndefined();
  expect(p.env.TERM).toBe("xterm-256color");
  const s2 = d.summary();
  expect(s2.kind).toBe("pty");
  expect(s2.capabilities.terminal).toBe(true);
  expect(s2.state).toBe("running");
  expect(s2.title).toBe("town-1");
  expect(s2.parent).toBe("agent:vm/abcd1234/town");
  expect(s2.pid).toBe(4242);
});

test("merges the lobby settings with the hooks", async () => {
  const dir = tmp();
  const lobby = join(dir, "settings.json");
  writeFileSync(lobby, JSON.stringify({ permissions: { allow: ["Bash(ccn *)"] }, hooks: { Stop: [{ hooks: [{ type: "command", command: "true" }] }] } }));
  const { p } = await start({ settings: lobby });
  const s = JSON.parse(readFileSync(p.argv[p.argv.indexOf("--settings") + 1]!, "utf8"));
  expect(s.permissions.allow).toEqual(["Bash(ccn *)"]);
  expect(s.hooks.Stop).toHaveLength(2);
  expect(s.hooks.Stop[0].hooks[0].type).toBe("command");
});

test("resume keeps the id; fork passes a new --session-id", async () => {
  expect(ptyArgv("claude", "new", "/s.json", { cwd: "/w", resume: "old" })).toEqual(["claude", "--resume", "old", "--settings", "/s.json"]);
  expect(ptyArgv("claude", "new", "/s.json", { cwd: "/w", resume: "old", fork: true })).toEqual(["claude", "--resume", "old", "--fork-session", "--session-id", "new", "--settings", "/s.json"]);
  const { d } = await start({ resume: "11111111-2222-3333-4444-555555555555" });
  expect(d.id).toBe("11111111-2222-3333-4444-555555555555");
});

test("childEnv drops Claude Code's own variables", () => {
  expect(childEnv({ A: "1", CLAUDECODE: "1", CLAUDE_CODE_MESSAGING_SOCKET: "/x", B: undefined })).toEqual({ A: "1", TERM: "xterm-256color", COLORTERM: "truecolor" });
});

test("attach: size, then the tail as replay, then live data; offsets are byte positions", async () => {
  const { d, p } = await start();
  p.emit("hello ");
  p.emit("world");
  const it = d.attach();
  const first = await take(it, 2);
  expect(first[0]).toEqual({ type: "size", cols: 120, rows: 40, epoch: d.epoch });
  expect(first[1]!.type).toBe("replay");
  expect(dec(first[1]!)).toBe("hello world");
  expect((first[1] as { offset: number }).offset).toBe(11);
  p.emit("!");
  const [live] = await take(it, 1);
  expect(live).toMatchObject({ type: "data", offset: 12 });
  expect(dec(live!)).toBe("!");
});

// #25: 17ms より詰まって届いた出力は1つの data にまとめる。間が空いていれば待たずに送る
test("output arriving within 17ms is sent as one data frame whose offset is the end", async () => {
  const { d, p } = await start();
  const it = d.attach();
  await take(it, 2); // size, replay
  p.emit("a"); // 前の data から間が空いているので、すぐ送る
  expect(await take(it, 1)).toMatchObject([{ type: "data", offset: 1 }]);
  p.emit("b"); p.emit("cd"); p.emit("e");
  const [merged] = await take(it, 1);
  expect(merged).toMatchObject({ type: "data", offset: 5 });
  expect(dec(merged!)).toBe("bcde");
  await Bun.sleep(25);
  p.emit("f");
  const [f] = await take(it, 1);
  expect(f).toMatchObject({ type: "data", offset: 6 });
});

test("held output is sent before a size frame, before exit, and before a new screen attaches", async () => {
  const { d, p } = await start();
  const it = d.attach();
  await take(it, 2);
  p.emit("x"); p.emit("y"); // y は待たされる
  d.resize(80, 24);
  const [x, y, size] = await take(it, 3);
  expect(dec(x!) + dec(y!)).toBe("xy");
  expect(y).toMatchObject({ type: "data", offset: 2 });
  expect(size).toMatchObject({ type: "size", cols: 80, rows: 24 });
  p.emit("z");
  // 待たされている z は今いる画面に送られ、新しい画面には replay に入る（重ならない）
  const late = d.attach();
  const [, replay] = await take(late, 2);
  expect(replay).toMatchObject({ type: "replay", offset: 3 });
  expect(dec((await take(it, 1))[0]!)).toBe("z");
  p.emit("w");
  p.exit(0);
  const tail = await take(it, 3);
  expect(tail.map((f) => f.type)).toEqual(["data", "exit"]);
  expect(dec(tail[0]!)).toBe("w");
});

test("attach with after inside the buffer sends only the rest as data; after outside replays", async () => {
  const { d, p } = await start({}, { maxBuffer: 10 });
  p.emit("abcde"); p.emit("fghij"); p.emit("klmno"); // 先頭の5バイトは捨てられる
  // epoch が違う（resume した別のプロセスの位置）なら replay からやり直す
  expect((await take(d.attach(12, d.epoch - 1), 2))[1]!.type).toBe("replay");
  const resumed = await take(d.attach(12, d.epoch), 2);
  expect(resumed[1]).toMatchObject({ type: "data", offset: 15 });
  expect(dec(resumed[1]!)).toBe("mno");
  // 範囲の外なら、捨てた分も含めた今の画面を replay で1回流す
  const old = await take(d.attach(2), 2);
  expect(old[1]).toMatchObject({ type: "replay", offset: 15 });
  expect(dec(old[1]!)).toBe("abcdefghijklmno");
});

test("replay restores the alternate screen, the cells drawn before the tail and the cursor", async () => {
  const { d, p } = await start({ cols: 20, rows: 5 });
  // 代替画面に入って枠を描き、その後は1か所だけを書き換える（claude の描き方）
  const frame = "\x1b[?1049h\x1b[H+--------+\r\n|        |\r\n+--------+";
  const moves = "\x1b[5;1H".repeat(800); // 画面を変えない出力。末尾のバイト列だけでは枠が入らない長さにする
  p.emit(frame); p.emit(moves); p.emit("\x1b[2;3Hhi");
  const [, replay] = await take(d.attach(), 2);
  expect(replay).toMatchObject({ type: "replay", offset: frame.length + moves.length + 8 });
  const text = dec(replay!);
  expect(text.startsWith("\x1b[?1049h")).toBe(true);
  expect(text).toContain("+--------+");
  expect(text).toContain("hi");
});

test("resize is last-writer-wins and is broadcast to attached screens", async () => {
  const { d, p } = await start();
  const it = d.attach();
  await take(it, 2);
  d.resize(80, 24);
  expect(p.resizes).toEqual([[80, 24]]);
  expect(await take(it, 1)).toEqual([{ type: "size", cols: 80, rows: 24, epoch: d.epoch }]);
  expect(d.size).toEqual({ cols: 80, rows: 24 });
});

test("send waits for SessionStart before pasting, and gives up with BusyError", async () => {
  const { d, p } = await start({}, { readyTimeoutMs: 30 });
  await expect(d.send("x")).rejects.toBeInstanceOf(BusyError);
  expect(p.writes).toEqual([]);
  const sending = d.send("y");
  await tick();
  expect(p.writes).toEqual([]);
  await d.hook({ hook_event_name: "SessionStart", source: "startup" });
  await sending;
  expect(p.writes).toEqual(["\x1b[200~y\x1b[201~", "\r"]);
});

// #26: SessionStart の hook は、claude が入力を読み始める（ESC[?2004h）より先に来る。その間に貼ると Enter が捨てられる
test("send waits for claude to start reading input (ESC[?2004h) after SessionStart", async () => {
  const { d, p } = await start({}, { inputTimeoutMs: 60_000 });
  const sending = d.send("hi");
  await d.hook({ hook_event_name: "SessionStart", source: "startup" });
  await tick();
  expect(p.writes).toEqual([]);
  p.emit("\x1b[?20"); // 列が出力の切れ目をまたいでも見つける
  await tick();
  expect(p.writes).toEqual([]);
  p.emit("04h\x1b[?1004h");
  await sending;
  expect(p.writes).toEqual(["\x1b[200~hi\x1b[201~", "\r"]);
});

test("send does not paste on the trust prompt: input is on but SessionStart has not come", async () => {
  const { d, p } = await start({}, { inputTimeoutMs: 60_000, readyTimeoutMs: 30 });
  p.emit("\x1b[?2004h");
  await expect(d.send("x")).rejects.toBeInstanceOf(BusyError);
  expect(p.writes).toEqual([]);
  // 画面のキー入力（信頼の確認への答え）は通る
  d.write(new TextEncoder().encode("1"));
  expect(p.writes).toEqual(["1"]);
});

test("keys typed before claude reads input are held and written in order once it does", async () => {
  const { d, p } = await start({}, { inputTimeoutMs: 60_000 });
  d.write(new TextEncoder().encode("hello"));
  d.write(new TextEncoder().encode("\r"));
  expect(p.writes).toEqual([]);
  p.emit("\x1b[?2004h");
  expect(p.writes).toEqual(["hello", "\r"]);
  d.write(new TextEncoder().encode("x"));
  expect(p.writes).toEqual(["hello", "\r", "x"]);
});

test("held keys are written anyway when ESC[?2004h does not come in time", async () => {
  const { d, p } = await start({}, { inputTimeoutMs: 20 });
  d.write(new TextEncoder().encode("a"));
  expect(p.writes).toEqual([]);
  await Bun.sleep(40);
  expect(p.writes).toEqual(["a"]);
  await d.hook({ hook_event_name: "SessionStart" });
  await d.send("b");
  expect(p.writes).toEqual(["a", "\x1b[200~b\x1b[201~", "\r"]);
});

test("send pastes the text with bracketed paste and presses Enter", async () => {
  const { d, p } = await start();
  await d.hook({ hook_event_name: "SessionStart" });
  const r = await d.send("from local via vm\n\nline1\nline2");
  expect(r.delivered).toBe("pty");
  expect(p.writes).toEqual(["\x1b[200~from local via vm\n\nline1\nline2\x1b[201~", "\r"]);
});

// hooks は途中の文を運ばないので、会話の行（SDK の getSessionMessages）から流す（2026-11-12、Claude Town のチャットで途中の文が出なかった）
const line = (uuid: string, type: string, content: unknown[], at = new Date(Date.now() + 1000).toISOString()) => ({ type, uuid, session_id: "s", parent_tool_use_id: null, timestamp: at, message: { role: type, content } });
test("assistant text written before a tool call is streamed from the transcript, in order, with tool results", async () => {
  const lines: ReturnType<typeof line>[] = [line("old", "assistant", [{ type: "text", text: "before resume" }], "2020-01-01T00:00:00Z")];
  const { d } = await start({}, { transcript: async () => lines });
  const evs = collect(d);
  await d.hook({ hook_event_name: "UserPromptSubmit", prompt: "go" });
  lines.push(line("u-prompt", "user", [{ type: "text", text: "go" }]));
  lines.push(line("a1", "assistant", [{ type: "thinking", thinking: "" }]));
  lines.push(line("a2", "assistant", [{ type: "text", text: "原因は特定できた。" }]));
  lines.push(line("a3", "assistant", [{ type: "tool_use", id: "t1", name: "Bash", input: { command: "ls" } }]));
  await d.hook({ hook_event_name: "PostToolUse", tool_name: "Bash", tool_input: { command: "ls" } });
  lines.push(line("r1", "user", [{ type: "tool_result", tool_use_id: "t1", content: "a" }]));
  lines.push(line("a4", "assistant", [{ type: "text", text: "終わった" }]));
  await d.hook({ hook_event_name: "Stop", last_assistant_message: "終わった" });
  await tick();
  expect(evs.map((e) => e.type)).toEqual(["user", "assistant", "assistant", "assistant", "user", "assistant", "result"]);
  // 行はそのまま流す（node のセッションと同じく、1行が1つの event）。resume の前の行と、打った文の行は流さない
  expect(evs.slice(1, 6).map((e) => (e.data as { uuid: string }).uuid)).toEqual(["a1", "a2", "a3", "r1", "a4"]);
  expect(evs[2]!.data).toEqual(lines[3]);
});

test("when the last line is not written yet at Stop, the hook text fills in and the line is not streamed twice", async () => {
  const lines: ReturnType<typeof line>[] = [];
  const { d } = await start({}, { transcript: async () => lines });
  const evs = collect(d);
  await d.hook({ hook_event_name: "UserPromptSubmit", prompt: "go" });
  await d.hook({ hook_event_name: "Stop", last_assistant_message: "done" });
  lines.push(line("late", "assistant", [{ type: "text", text: "done" }]));
  await d.hook({ hook_event_name: "UserPromptSubmit", prompt: "next" });
  lines.push(line("n1", "assistant", [{ type: "text", text: "next answer" }]));
  await d.hook({ hook_event_name: "Stop", last_assistant_message: "next answer" });
  await tick();
  const texts = evs.filter((e) => e.type === "assistant").map((e) => ((e.data as { message: { content: { text: string }[] } }).message.content[0]!.text));
  expect(texts).toEqual(["done", "next answer"]);
  expect(evs.map((e) => e.type)).toEqual(["user", "assistant", "result", "user", "assistant", "result"]);
});

test("a failing transcript read does not break the turn", async () => {
  const { d } = await start({}, { transcript: async () => { throw new Error("no file"); } });
  const evs = collect(d);
  await d.hook({ hook_event_name: "UserPromptSubmit", prompt: "go" });
  await d.hook({ hook_event_name: "PostToolUse", tool_name: "Bash", tool_input: {} });
  await d.hook({ hook_event_name: "Stop", last_assistant_message: "ok" });
  await tick();
  // 読めないときは今までどおり hooks から組み立てる
  expect(evs.map((e) => e.type)).toEqual(["user", "assistant", "assistant", "result"]);
  expect(d.summary().state).toBe("idle");
});

// #43: 承認の要らない道具の tool_use は、PostToolUse（道具が終わった後）まで読まれなかった。tool_result の行は PostToolUse より後に書かれる
test("PreToolUse streams the tool_use line while the tool runs, without making the hook wait for the read", async () => {
  const lines: ReturnType<typeof line>[] = [];
  let release!: () => void;
  let reads = 0;
  const { d } = await start({}, { chaseDelaysMs: [5], transcript: async () => { reads++; if (reads === 1) await new Promise<void>((r) => { release = r; }); return lines; } });
  const evs = collect(d);
  await d.hook({ hook_event_name: "UserPromptSubmit", prompt: "go" });
  lines.push(line("a1", "assistant", [{ type: "tool_use", id: "t1", name: "Bash", input: { command: "sleep 30" } }]));
  // hook の応答は読み込みを待たない（待つと道具の開始が遅れる）
  expect(await d.hook({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "sleep 30" }, tool_use_id: "t1" })).toBeUndefined();
  expect(evs.map((e) => e.type)).toEqual(["user"]);
  release();
  await tick();
  expect(evs.map((e) => e.type)).toEqual(["user", "assistant"]);
  expect(d.summary().state).toBe("running");
});

test("after PostToolUse, the tool_result line written later is read again until it shows up, then reading stops", async () => {
  const lines: ReturnType<typeof line>[] = [line("a1", "assistant", [{ type: "tool_use", id: "t1", name: "Bash", input: {} }])];
  let reads = 0;
  const { d } = await start({}, { chaseDelaysMs: [5, 5, 5, 5, 5, 5], transcript: async () => { reads++; return lines; } });
  const evs = collect(d);
  await d.hook({ hook_event_name: "UserPromptSubmit", prompt: "go" });
  await d.hook({ hook_event_name: "PostToolUse", tool_name: "Bash", tool_input: {}, tool_use_id: "t1" });
  expect(evs.map((e) => e.type)).toEqual(["user", "assistant"]);
  await Bun.sleep(8);
  lines.push(line("r1", "user", [{ type: "tool_result", tool_use_id: "t1", content: "hi" }]));
  await Bun.sleep(40);
  expect(evs.map((e) => e.type)).toEqual(["user", "assistant", "user"]);
  const after = reads;
  await Bun.sleep(40);
  expect(reads).toBe(after); // 結果の行が出たら読み直しをやめる
  expect(reads).toBeLessThan(6);
});

test("reading again gives up after the last delay, and tools of a subagent are not chased", async () => {
  let reads = 0;
  const { d } = await start({}, { chaseDelaysMs: [2, 2], transcript: async () => { reads++; return []; } });
  await d.hook({ hook_event_name: "PostToolUse", tool_name: "Bash", tool_input: {}, tool_use_id: "t9" });
  await Bun.sleep(30);
  expect(reads).toBe(3); // PostToolUse の1回と、間隔ごとの2回
  await d.hook({ hook_event_name: "PostToolUse", tool_name: "Bash", tool_input: {}, tool_use_id: "t10", agent_id: "sub1" });
  await Bun.sleep(30);
  expect(reads).toBe(4);
});

test("overlapping reads are merged: one running read and one more after it", async () => {
  let reads = 0;
  let release!: () => void;
  const { d } = await start({}, { chaseDelaysMs: [], transcript: async () => { reads++; if (reads === 1) await new Promise<void>((r) => { release = r; }); return []; } });
  for (let i = 0; i < 5; i++) await d.hook({ hook_event_name: "PreToolUse", tool_name: "Read", tool_input: {}, tool_use_id: `p${i}` });
  expect(reads).toBe(1);
  release();
  await tick();
  expect(reads).toBe(2);
});

test("permission via hooks: pending, event, allow resolves the hook with the decision", async () => {
  const { d } = await start();
  const evs = collect(d);
  const out = d.hook({ hook_event_name: "PermissionRequest", tool_name: "Bash", tool_input: { command: "rm -rf x", description: "remove" }, permission_mode: "default" });
  await tick();
  expect(d.summary().state).toBe("waiting_permission");
  const [p] = d.pending();
  expect(p).toMatchObject({ toolName: "Bash", input: { command: "rm -rf x" }, description: "remove" });
  expect(evs.map((e) => e.type)).toEqual(["permission_request"]);
  // 承認画面が出ている間は Enter を押させない
  await expect(d.send("x")).rejects.toBeInstanceOf(BusyError);
  await d.answer(p!.requestId, { behavior: "allow" });
  expect(await out).toEqual({ hookSpecificOutput: { hookEventName: "PermissionRequest", decision: { behavior: "allow", updatedInput: { command: "rm -rf x", description: "remove" } } } });
  expect(d.summary().state).toBe("running");
  expect(evs.map((e) => e.type)).toEqual(["permission_request", "permission_answered"]);
});

test("deny carries the message", async () => {
  const { d } = await start();
  const out = d.hook({ hook_event_name: "PermissionRequest", tool_name: "Write", tool_input: { file_path: "/a" } });
  await tick();
  await d.answer(d.pending()[0]!.requestId, { behavior: "deny", message: "no" });
  expect(await out).toEqual({ hookSpecificOutput: { hookEventName: "PermissionRequest", decision: { behavior: "deny", message: "no" } } });
});

test("a permission answered in the terminal is cleared when the same tool call finishes", async () => {
  const { d } = await start();
  const evs = collect(d);
  const out = d.hook({ hook_event_name: "PermissionRequest", tool_name: "Bash", tool_input: { command: "ls" } });
  await tick();
  await d.hook({ hook_event_name: "PostToolUse", tool_name: "Bash", tool_input: { command: "ls" } });
  expect(await out).toBeUndefined();
  expect(d.pending()).toEqual([]);
  expect(d.summary().state).toBe("running");
  expect(evs.map((e) => e.type)).toEqual(["permission_request", "permission_answered", "assistant"]);
});

test("Stop ends the turn: assistant text, then result, then idle", async () => {
  const { d } = await start();
  const evs = collect(d);
  await d.hook({ hook_event_name: "UserPromptSubmit", prompt: "hi" });
  expect(d.summary().state).toBe("running");
  await d.hook({ hook_event_name: "Stop", last_assistant_message: "done" });
  await tick();
  expect(d.summary().state).toBe("idle");
  expect(evs.map((e) => e.type)).toEqual(["user", "assistant", "result"]);
  expect((evs[1]!.data as { message: { content: Array<{ text: string }> } }).message.content[0]!.text).toBe("done");
});

test("interrupt writes Esc and, when claude agents says idle, ends the turn", async () => {
  let info: AgentInfo = { pid: 4242, cwd: "/w", kind: "interactive", startedAt: 0, status: "idle" };
  const { d, p } = await start({ prompt: "x" }, { agentInfo: async () => info });
  const evs = collect(d);
  // 引数の文の UserPromptSubmit が届く前は、agents が idle でもターンを終わらせない
  await d.interrupt();
  await new Promise((r) => setTimeout(r, 30));
  expect(d.summary().state).toBe("running");
  p.writes.length = 0;
  await d.hook({ hook_event_name: "UserPromptSubmit", prompt: "x" });
  await d.interrupt();
  expect(p.writes).toEqual(["\x1b"]);
  await new Promise((r) => setTimeout(r, 30));
  expect(d.summary().state).toBe("idle");
  expect(evs.at(-1)).toMatchObject({ type: "result", data: { subtype: "interrupted" } });
  void info;
});

test("terminal input while a permission is pending reconciles with claude agents and drops the stale request", async () => {
  let info: AgentInfo = { pid: 4242, cwd: "/w", kind: "interactive", startedAt: 0, status: "waiting", waitingFor: "permission prompt" };
  const { d } = await start({}, { agentInfo: async () => info });
  const out = d.hook({ hook_event_name: "PermissionRequest", tool_name: "Bash", tool_input: { command: "ls" } });
  await tick();
  d.write(new TextEncoder().encode("\x1b"));
  info = { ...info, status: "idle", waitingFor: undefined };
  await new Promise((r) => setTimeout(r, 30));
  expect(await out).toBeUndefined();
  expect(d.pending()).toEqual([]);
  expect(d.summary().state).toBe("idle");
});

test("exit: pending hooks are released, screens get exit, events end with exited, settings file is removed", async () => {
  const { d, p } = await start();
  const file = p.argv[p.argv.indexOf("--settings") + 1]!;
  const evs = collect(d);
  const it = d.attach();
  await take(it, 2);
  const out = d.hook({ hook_event_name: "PermissionRequest", tool_name: "Bash", tool_input: {} });
  await tick();
  p.exit(1);
  await tick();
  expect(await out).toBeUndefined();
  expect(await take(it, 5)).toEqual([{ type: "exit", code: 1, reason: "exit 1" }]);
  expect(d.summary().state).toBe("exited");
  expect(d.capabilities.send).toBe(false);
  expect(d.capabilities.terminal).toBe(true);
  expect(evs.at(-1)).toMatchObject({ type: "exited" });
  expect(existsSync(file)).toBe(false);
  await expect(d.send("x")).rejects.toBeInstanceOf(ExitedError);
  // 終わった後も replay と exit は読める
  p.emit("late");
  const after = await take(d.attach(), 5);
  expect(after.map((f) => f.type)).toEqual(["size", "replay", "exit"]);
  expect(dec(after[1]!)).toContain("late");
});

test("stop sends SIGTERM and waits for the exit", async () => {
  const { d, p } = await start();
  await d.stop();
  expect(p.kills).toEqual(["SIGTERM"]);
  expect(d.summary().state).toBe("exited");
});

test("stopPtysOnExit stops the live PTY children before the node exits", async () => {
  const { stopPtysOnExit } = await import("../../src/main");
  const { SessionStore } = await import("../../src/sessions/store");
  const store = new SessionStore();
  const { d, p } = await start();
  store.add(d);
  const codes: number[] = [];
  const onSignal = stopPtysOnExit(store, (c) => { codes.push(c); }, false);
  await onSignal();
  expect(p.kills).toEqual(["SIGTERM"]);
  expect(codes).toEqual([0]);
});

test("a screen that stops reading before the live part does not stay subscribed", async () => {
  const { d, p } = await start();
  const it = d.attach()[Symbol.asyncIterator]();
  await it.next();
  await it.return?.();
  p.emit("x".repeat(100));
  expect((d as unknown as { subs: Set<unknown> }).subs.size).toBe(0);
});
