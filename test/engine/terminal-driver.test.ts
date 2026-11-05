import { test, expect } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TerminalDriver, SocketGoneError, unixConnect } from "../../src/engine/terminal-driver";
import { CapabilityError } from "../../src/engine/driver";
import type { AgentInfo } from "../../src/engine/agents";

const info: AgentInfo = { pid: 4242, cwd: "/tmp", kind: "interactive", startedAt: 0, sessionId: "term-1", status: "busy" };
const until = async (f: () => boolean) => { for (let i = 0; i < 50 && !f(); i++) await new Promise((r) => setTimeout(r, 10)); expect(f()).toBe(true); };

test("send writes exactly one json line in the cross-session shape", async () => {
  const path = join(mkdtempSync(join(tmpdir(), "cc-sock-")), "4242.sock");
  let got = "";
  const server = Bun.listen({ unix: path, socket: { data(_s, d) { got += Buffer.from(d).toString(); } } });
  const d = new TerminalDriver(info, { uid: 501, connect: unixConnect, socketPaths: () => [path] });
  const r = await d.send("hello");
  expect(r.delivered).toBe("socket");
  await until(() => got.endsWith("\n"));
  expect(got).toBe(JSON.stringify({ type: "user", message: { role: "user", content: "hello" } }) + "\n");
  server.stop(true);
});

test("send throws SocketGoneError when no candidate path connects", async () => {
  const d = new TerminalDriver(info, { uid: 501, connect: unixConnect, socketPaths: () => ["/nonexistent/cc/4242.sock"] });
  await expect(d.send("x")).rejects.toBeInstanceOf(SocketGoneError);
});

test("answer and interrupt throw CapabilityError", async () => {
  const d = new TerminalDriver(info, { uid: 501, connect: unixConnect });
  await expect(d.answer("r", { behavior: "allow" })).rejects.toBeInstanceOf(CapabilityError);
  await expect(d.interrupt()).rejects.toBeInstanceOf(CapabilityError);
  expect(d.capabilities).toEqual({ send: true, permissions: false, interrupt: false, stop: false, events: false });
});

test("summary maps status to state", () => {
  const mk = (status: AgentInfo["status"]) => new TerminalDriver({ ...info, status }, { uid: 501, connect: unixConnect }).summary();
  expect(mk("busy").state).toBe("running");
  expect(mk("waiting").state).toBe("waiting_permission");
  expect(mk("idle").state).toBe("idle");
  expect(mk("busy").kind).toBe("terminal");
  expect(mk("busy").pid).toBe(4242);
  expect(mk("busy").id).toBe("term-1");
});
