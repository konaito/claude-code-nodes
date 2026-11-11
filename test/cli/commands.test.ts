import { test, expect } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { main, type Ctx } from "../../src/cli/commands";
import type { Config } from "../../src/config";
import type { SessionSummary } from "../../src/sessions/types";

const cfg: Config = { name: "pro", port: 4323, roots: ["/"], domain: "cc.fybe.jp", serviceToken: { clientId: "cid", clientSecret: "csec" } };
const caps = (events: boolean) => ({ send: true, permissions: events, interrupt: events, stop: events, events });
const sess = (id: string, over: Partial<SessionSummary> = {}): SessionSummary => ({ id, kind: "node", capabilities: caps(true), cwd: "/home/u/proj", state: "idle", startedAt: 0, lastActivityAt: 0, ...over });

// 偽のノード。URL ごとに応答を返し、受けた Request を記録する
function fakeNode(opts: { sessions?: SessionSummary[]; pending?: unknown[]; sse?: string; messages?: unknown[]; detailState?: string; cursor?: number } = {}) {
  const calls: Array<{ method: string; url: string; body?: unknown; headers: Headers }> = [];
  const sessions = opts.sessions ?? [sess("abcd1234-0000-0000-0000-000000000000")];
  const fetchFn = (async (i: RequestInfo | URL, init?: RequestInit) => {
    const r = new Request(i, init);
    const u = new URL(r.url);
    const body = r.method === "POST" || r.method === "PATCH" ? await r.json().catch(() => undefined) : undefined;
    calls.push({ method: r.method, url: r.url, body, headers: r.headers });
    const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status, headers: { "content-type": "application/json" } });
    if (u.pathname === "/api/peers") return json([{ name: "pro", url: "http://127.0.0.1:4323", status: "healthy", self: true }, { name: "vm", url: "https://vm.cc.fybe.jp", status: "healthy", self: false }]);
    if (u.pathname === "/api/sessions" && r.method === "GET") return json(sessions);
    if (u.pathname === "/api/sessions" && r.method === "POST") return json({ id: "new00000-1111-2222-3333-444444444444" }, 201);
    const m = u.pathname.match(/^\/api\/sessions\/([^/]+)(?:\/(.*))?$/);
    if (!m) return json({ error: "nf" }, 404);
    const s = sessions.find((x) => x.id === m[1]);
    if (!s) return json({ error: "unknown session" }, 404);
    if (!m[2] && r.method === "GET") return json({ ...s, state: opts.detailState ?? s.state, pending: opts.pending ?? [], ...(opts.cursor !== undefined ? { cursor: opts.cursor } : {}) });
    if (!m[2] && r.method === "DELETE") return new Response(null, { status: 204 });
    if (m[2] === "messages" && r.method === "GET") { const after = Number(u.searchParams.get("after") ?? 0); const msgs = (opts.messages ?? []).slice(after); return json({ messages: msgs, next: msgs.length ? after + msgs.length : undefined }); }
    if (m[2] === "messages" && r.method === "POST") return json({ delivered: "stdin" });
    if (m[2] === "events") return new Response(opts.sse ?? "", { headers: { "content-type": "text/event-stream" } });
    if (m[2]?.startsWith("permissions/")) return json({ ok: true });
    if (m[2] === "interrupt") return json({ ok: true });
    return json({ error: "nf" }, 404);
  }) as typeof fetch;
  return { calls, fetchFn };
}
function ctx(fetchFn: typeof fetch, over: Partial<Ctx> = {}): Ctx & { lines: string[] } {
  const lines: string[] = [];
  const dir = mkdtempSync(join(tmpdir(), "cc-cli-"));
  return { cfg, env: { CLAUDE_CODE_SESSION_ID: "abcdef12-0000-0000-0000-000000000000", HOME: dir }, out: (s) => lines.push(s), fetchFn, stdin: async () => "from stdin", sendsPath: join(dir, "sends.json"), lines, ...over };
}
const ev = (seq: number, event: string, data: unknown) => `id: ${seq}\nevent: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
const assistant = (text: string) => ({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text }] } });

test("peers lists the registry from the local node", async () => {
  const n = fakeNode();
  const c = ctx(n.fetchFn);
  expect(await main(["peers"], c)).toBe(0);
  expect(c.lines).toEqual(["pro healthy http://127.0.0.1:4323 (self)", "vm healthy https://vm.cc.fybe.jp"]);
  expect(n.calls[0]!.url).toBe("http://127.0.0.1:4323/api/peers");
});

test("ls prints one line per session across peers and --mine filters by parent", async () => {
  const n = fakeNode({ sessions: [sess("abcd1234-0000-0000-0000-000000000000", { parent: "agent:pro/abcdef12/lead" }), sess("ffff0000-0000-0000-0000-000000000000", { parent: "ceo@fybe.jp", kind: "terminal", capabilities: caps(false) })] });
  const c = ctx(n.fetchFn);
  expect(await main(["ls", "--peer", "vm"], c)).toBe(0);
  expect(c.lines[0]).toBe("vm/abcd1234  node      idle                /home/u/proj  agent:pro/abcdef12/lead  ");
  expect(c.lines[1]).toContain("vm/ffff0000  terminal  idle");
  expect(n.calls[0]!.url).toBe("https://ccn-vm.fybe.jp/api/sessions");
  expect(n.calls[0]!.headers.get("cf-access-client-id")).toBe("cid");
  const d = ctx(n.fetchFn);
  await main(["ls", "--peer", "vm", "--mine"], d);
  expect(d.lines.length).toBe(1);
  expect(d.lines[0]).toContain("abcd1234");
});

test("new posts cwd, raw prompt and bypass mode by default", async () => {
  const n = fakeNode();
  const c = ctx(n.fetchFn);
  expect(await main(["new", "/home/u/proj", "do the thing", "--peer", "vm", "--as", "lead"], c)).toBe(0);
  expect(c.lines).toEqual(["vm/new00000-1111-2222-3333-444444444444"]);
  const call = n.calls[0]!;
  expect(call.url).toBe("https://ccn-vm.fybe.jp/api/sessions");
  expect(call.body).toEqual({ cwd: "/home/u/proj", prompt: "do the thing", permissionMode: "bypassPermissions" });
  expect(call.headers.get("x-cc-from")).toBe("agent:pro/abcdef12/lead");
  const d = ctx(n.fetchFn);
  await main(["new", "/home/u/proj", "x", "--mode", "default", "--model", "opus", "--resume", "old1"], d);
  expect(n.calls[1]!.body).toEqual({ cwd: "/home/u/proj", prompt: "x", permissionMode: "default", model: "opus", resume: "old1" });
});

test("send remembers the seq and read uses it", async () => {
  const n = fakeNode({ messages: [assistant("a"), assistant("b"), assistant("c")], sse: ev(4, "assistant", assistant("done")) + ev(5, "result", { subtype: "success" }) });
  const c = ctx(n.fetchFn);
  expect(await main(["send", "abcd1234", "hello"], c)).toBe(0);
  expect(c.lines).toEqual(["seq=3"]);
  const post = n.calls.find((x) => x.method === "POST")!;
  expect(post.url).toBe("http://127.0.0.1:4323/api/sessions/abcd1234-0000-0000-0000-000000000000/messages");
  expect(post.body).toEqual({ text: "hello" });
  const d = ctx(n.fetchFn, { sendsPath: c.sendsPath });
  expect(await main(["read", "abcd1234"], d)).toBe(0);
  const sse = n.calls.find((x) => x.url.includes("/events"))!;
  expect(sse.url).toContain("after=3");
  expect(d.lines).toContain("done");
  expect(d.lines.at(-1)).toBe("state=idle pending=0 seq=5");
});

test("send with - reads the text from stdin", async () => {
  const n = fakeNode({ messages: [] });
  const c = ctx(n.fetchFn);
  await main(["send", "abcd1234", "-"], c);
  expect(n.calls.find((x) => x.method === "POST")!.body).toEqual({ text: "from stdin" });
});

test("read over sse returns 3 on permission_request and 4 on exited", async () => {
  const perm = fakeNode({ sse: ev(2, "permission_request", { requestId: "r1", toolName: "Write", input: { file_path: "/x.txt", content: "a" }, description: "/x.txt" }), pending: [{ requestId: "r1", toolName: "Write" }], detailState: "waiting_permission" });
  const c = ctx(perm.fetchFn);
  expect(await main(["read", "abcd1234", "--after", "0"], c)).toBe(3);
  expect(c.lines).toContain('[permission] Write file_path="/x.txt" requestId=r1');
  expect(c.lines.at(-1)).toBe("state=waiting_permission pending=1 seq=2");
  const dead = fakeNode({ sse: ev(2, "exited", { reason: "ended" }), detailState: "exited" });
  expect(await main(["read", "abcd1234", "--after", "0"], ctx(dead.fetchFn))).toBe(4);
});

test("read returns 2 when nothing arrives within --wait", async () => {
  const n = fakeNode({ sse: "" });
  const c = ctx(n.fetchFn);
  expect(await main(["read", "abcd1234", "--after", "0", "--wait", "0"], c)).toBe(2);
});

test("read polls messages when the session has no events capability", async () => {
  const term = sess("tttt0000-0000-0000-0000-000000000000", { kind: "terminal", capabilities: caps(false) });
  const n = fakeNode({ sessions: [term], messages: [{ type: "user", message: { content: "hi" } }, assistant("reply from terminal")] });
  const c = ctx(n.fetchFn, { pollMs: 1 });
  expect(await main(["read", "tttt0000", "--after", "1", "--wait", "2"], c)).toBe(0);
  expect(c.lines).toContain("reply from terminal");
  expect(n.calls.some((x) => x.url.includes("/events"))).toBe(false);
});

test("allow picks the single pending request and deny needs a reason", async () => {
  const n = fakeNode({ pending: [{ requestId: "r1", toolName: "Write" }] });
  const c = ctx(n.fetchFn);
  expect(await main(["allow", "abcd1234"], c)).toBe(0);
  const p = n.calls.find((x) => x.url.includes("/permissions/"))!;
  expect(p.url).toContain("/permissions/r1");
  expect(p.body).toEqual({ behavior: "allow" });
  expect(await main(["deny", "abcd1234", "r1", "not now"], c)).toBe(0);
  expect(n.calls.filter((x) => x.url.includes("/permissions/")).at(-1)!.body).toEqual({ behavior: "deny", message: "not now" });
  const two = fakeNode({ pending: [{ requestId: "r1", toolName: "Write" }, { requestId: "r2", toolName: "Bash" }] });
  expect(await main(["allow", "abcd1234"], ctx(two.fetchFn))).not.toBe(0);
});

test("show, interrupt and stop hit the right endpoints", async () => {
  const n = fakeNode({ pending: [
    { requestId: "r1", toolName: "Write", input: { file_path: "/x", content: "hi" }, description: "/x" },
    { requestId: "r2", toolName: "Bash", input: { command: "git push origin main\nrm -rf /", description: "Push" }, description: "Push" },
    { requestId: "r3", toolName: "Bash" },
  ] });
  const c = ctx(n.fetchFn);
  expect(await main(["show", "abcd1234"], c)).toBe(0);
  expect(c.lines.some((l) => l.startsWith("state: idle"))).toBe(true);
  // 承認する側が中身で判断できるように、file_path と command を出す。改行は逃がして1行に収め、偽の pending: 行を作らせない
  expect(c.lines).toContain('pending: r1 Write file_path="/x"');
  expect(c.lines).toContain('pending: r2 Bash command="git push origin main\\nrm -rf /" ("Push")');
  expect(c.lines).toContain("pending: r3 Bash (中身なし)");
  expect(c.lines.filter((l) => l.startsWith("pending:"))).toHaveLength(3);
  expect(await main(["interrupt", "abcd1234"], c)).toBe(0);
  expect(await main(["stop", "abcd1234"], c)).toBe(0);
  expect(n.calls.map((x) => `${x.method} ${new URL(x.url).pathname}`)).toContain("POST /api/sessions/abcd1234-0000-0000-0000-000000000000/interrupt");
  expect(n.calls.map((x) => `${x.method} ${new URL(x.url).pathname}`)).toContain("DELETE /api/sessions/abcd1234-0000-0000-0000-000000000000");
});

test("unknown command and missing config print usage and return 1", async () => {
  const c = ctx(fakeNode().fetchFn);
  expect(await main(["nope"], c)).toBe(1);
  expect(await main([], c)).toBe(1);
  expect(c.lines.some((l) => l.includes("ccn peers"))).toBe(true);
});

test("ls skips a down peer with one line instead of calling it", async () => {
  const n = fakeNode();
  const calls0 = n.calls.length;
  const c = ctx((async (i: RequestInfo | URL, init?: RequestInit) => {
    const u = new URL(new Request(i, init).url);
    if (u.pathname === "/api/peers") return new Response(JSON.stringify([{ name: "pro", url: "http://127.0.0.1:4323", status: "healthy", self: true }, { name: "vm", url: "https://vm.cc.fybe.jp", status: "inactive", self: false }]), { headers: { "content-type": "application/json" } });
    return n.fetchFn(i, init);
  }) as typeof fetch);
  expect(await main(["ls"], c)).toBe(0);
  expect(c.lines.some((l) => l.startsWith("vm  (inactive)"))).toBe(true);
  expect(n.calls.slice(calls0).some((x) => x.url.startsWith("https://ccn-vm.fybe.jp"))).toBe(false);
});

test("new resolves a relative dir for the local node and refuses it for a remote one", async () => {
  const n = fakeNode();
  const c = ctx(n.fetchFn);
  expect(await main(["new", ".", "x"], c)).toBe(0);
  expect((n.calls[0]!.body as { cwd: string }).cwd).toBe(process.cwd());
  expect(await main(["new", "rel/dir", "x", "--peer", "vm"], c)).toBe(1);
  expect(n.calls.length).toBe(1);
});

test("send uses the cursor from the detail and calls /api/sessions/:id directly for a full id", async () => {
  const full = "abcd1234-0000-0000-0000-000000000000";
  const n = fakeNode({ cursor: 42, messages: [assistant("a")] });
  const c = ctx(n.fetchFn);
  expect(await main(["send", full, "hello"], c)).toBe(0);
  expect(c.lines).toEqual(["seq=42"]);
  expect(n.calls.map((x) => `${x.method} ${new URL(x.url).pathname}`)).toEqual([`GET /api/sessions/${full}`, `POST /api/sessions/${full}/messages`]);
  // 先頭8文字なら一覧で絞ってから詳細。messages はたどらない
  const d = ctx(n.fetchFn);
  const before = n.calls.length;
  expect(await main(["send", "abcd1234", "hello"], d)).toBe(0);
  expect(n.calls.slice(before).map((x) => `${x.method} ${new URL(x.url).pathname}`)).toEqual(["GET /api/sessions", `GET /api/sessions/${full}`, `POST /api/sessions/${full}/messages`]);
  // 無い完全な id は 1 を返す
  expect(await main(["send", "ffffffff-0000-0000-0000-000000000000", "hello"], ctx(n.fetchFn))).toBe(1);
});

test("new without a dir starts in the lobby and without a text waits for the first send", async () => {
  const n = fakeNode();
  const c = ctx(n.fetchFn);
  expect(await main(["new"], c)).toBe(0);
  expect(c.lines).toEqual(["pro/new00000-1111-2222-3333-444444444444"]);
  expect(n.calls[0]!.url).toBe("http://127.0.0.1:4323/api/sessions");
  expect(n.calls[0]!.body).toEqual({ permissionMode: "bypassPermissions" });
  const d = ctx(n.fetchFn);
  expect(await main(["new", "--peer", "vm", "--mode", "default"], d)).toBe(0);
  expect(d.lines).toEqual(["vm/new00000-1111-2222-3333-444444444444"]);
  expect(n.calls[1]!.body).toEqual({ permissionMode: "default" });
  const e = ctx(n.fetchFn);
  expect(await main(["new", "/home/u/proj"], e)).toBe(0);
  expect(n.calls[2]!.body).toEqual({ cwd: "/home/u/proj", permissionMode: "bypassPermissions" });
});

test("new without a text on an old node says the node needs ccn update", async () => {
  for (const error of ["prompt or resume is required", "cwd is required"]) {
    const fetchFn = (async () => new Response(JSON.stringify({ error }), { status: 400, headers: { "content-type": "application/json" } })) as unknown as typeof fetch;
    const errs: string[] = [];
    const c = ctx(fetchFn, { err: (s) => errs.push(s) });
    expect(await main(["new", "--peer", "vm"], c)).toBe(1);
    expect(errs.join("\n")).toContain("古い版");
    expect(errs.join("\n")).toContain("update");
  }
});

test("show without a target shows this Claude Code session (CLAUDE_CODE_SESSION_ID) on the local node", async () => {
  const n = fakeNode({ sessions: [sess("abcdef12-0000-0000-0000-000000000000", { permissionMode: "default" })] });
  const c = ctx(n.fetchFn);
  expect(await main(["show"], c)).toBe(0);
  expect(c.lines).toContain("id: abcdef12-0000-0000-0000-000000000000");
  expect(c.lines).toContain("permissionMode: default");
  const bare = ctx(n.fetchFn, { env: { HOME: tmpdir() } });
  const errs: string[] = [];
  expect(await main(["show"], { ...bare, err: (s) => errs.push(s) })).toBe(1);
  expect(errs.join("\n")).toContain("対象");
});
