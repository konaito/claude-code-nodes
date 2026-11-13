import { test, expect } from "bun:test";
import { listAgents, socketPathFor, withoutHeadless, type AgentInfo } from "../../src/engine/agents";

test("listAgents parses the real json shape", async () => {
  const run = async () => ({ stdout: await Bun.file("test/fixtures/agents.json").text(), code: 0 });
  const list = await listAgents(run);
  expect(list.length).toBe(3);
  expect(list[0].pid).toBe(14356);
  expect(list[0].kind).toBe("interactive");
  expect(list[0].sessionId).toBe("bfa86f8f-1741-459d-9473-052f8c0aa56f");
  expect(list[1].waitingFor).toBe("permission prompt");
});

test("listAgents returns [] when the command fails", async () => {
  const run = async () => ({ stdout: "", code: 1 });
  expect(await listAgents(run)).toEqual([]);
});

test("socketPathFor lists both candidate paths in order", () => {
  expect(socketPathFor(123, 501)).toEqual(["/tmp/cc-socks/123.sock", "/tmp/cc-socks-501/123.sock"]);
});

const row = (pid: number | undefined, sessionId: string): AgentInfo => ({ pid, cwd: "/tmp", kind: "interactive", startedAt: 1, sessionId });
const psRunner = (stdout: string, code = 0) => {
  const calls: string[][] = [];
  const run = async (cmd: string[]) => { calls.push(cmd); return { stdout, code }; };
  return { run, calls };
};

test("withoutHeadless drops claude -p without a controlling terminal, asking ps once", async () => {
  const { run, calls } = psRunner([
    "  101 ??       claude -p --no-session-persistence --model sonnet",
    "  102 ttys003  claude --dangerously-skip-permissions",
    "  103 ?        /usr/bin/claude --print hello",
  ].join("\n"));
  const out = await withoutHeadless([row(101, "a"), row(102, "b"), row(103, "c")], run);
  expect(out.map((a) => a.sessionId)).toEqual(["b"]);
  expect(calls).toEqual([["ps", "-o", "pid=,tty=,command=", "-p", "101,102,103"]]);
});

test("withoutHeadless keeps a terminal session whose argv prompt mentions -p", async () => {
  // ccn の PTY の子は最初の文を引数で受ける。文の中の `claude -p` は制御端末があるので消さない
  const { run } = psRunner("98037 ttys039  /Users/x/.local/bin/claude --session-id s --settings f --name n 裏方の claude -p --no-session-persistence を除く");
  expect((await withoutHeadless([row(98037, "a")], run)).map((a) => a.sessionId)).toEqual(["a"]);
});

test("withoutHeadless keeps headless processes that are not print mode", async () => {
  const { run } = psRunner("201 ??       claude --output-format stream-json -prompt-like");
  expect((await withoutHeadless([row(201, "a")], run)).length).toBe(1);
});

test("withoutHeadless keeps rows without a pid and skips ps when there is no pid", async () => {
  const { run, calls } = psRunner("");
  expect((await withoutHeadless([row(undefined, "a")], run)).length).toBe(1);
  expect(calls).toEqual([]);
});

test("withoutHeadless keeps everything when ps fails", async () => {
  expect((await withoutHeadless([row(101, "a")], psRunner("", 1).run)).length).toBe(1);
  const throwing = async () => { throw new Error("no ps"); };
  expect((await withoutHeadless([row(101, "a")], throwing)).length).toBe(1);
});

test("withoutHeadless keeps rows that ps did not return, and ignores pids it did not ask for", async () => {
  // 101 は ps の前に終わった。999 は問い合わせていない
  const { run } = psRunner("  102 ??  claude --dangerously-skip-permissions\n  999 ??  claude -p x");
  expect((await withoutHeadless([row(101, "a"), row(102, "b")], run)).map((a) => a.sessionId)).toEqual(["a", "b"]);
});
