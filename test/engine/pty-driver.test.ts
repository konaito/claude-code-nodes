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
  const d = await PtyDriver.start({ cwd: "/w", ...over }, { spawn: f.spawn, hookBase: "http://127.0.0.1:9", caller: "agent:vm/abcd1234/town", claudePath: "claude", env: { PATH: "/bin", CLAUDECODE: "1", CLAUDE_CODE_SESSION_ID: "x" }, tmp: tmp(), pasteDelayMs: 0, reconcileDelayMs: 5, ...deps });
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
  expect(Object.keys(s.hooks).sort()).toEqual(["Notification", "PermissionRequest", "PostToolUse", "PostToolUseFailure", "SessionStart", "Stop", "StopFailure", "UserPromptSubmit"]);
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

test("send pastes the text with bracketed paste and presses Enter", async () => {
  const { d, p } = await start();
  await d.hook({ hook_event_name: "SessionStart" });
  const r = await d.send("from local via vm\n\nline1\nline2");
  expect(r.delivered).toBe("pty");
  expect(p.writes).toEqual(["\x1b[200~from local via vm\n\nline1\nline2\x1b[201~", "\r"]);
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
