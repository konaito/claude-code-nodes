// 本物の claude を動かす試験。CC_LIVE=1 のときだけ。VM で回す
import { test, expect } from "bun:test";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/api/app";
import { buildDeps } from "../src/main";
import { waitFor } from "./helpers/sse-client";

const t = process.env.CC_LIVE === "1" ? test : test.skip;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

t("live: create, read result over SSE, send, permission allow, interrupt, stop, resume", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "cc-live-"));
  const app = createApp(buildDeps({ name: "live", port: 0, roots: [tmpdir()] }));
  const post = (p: string, b: unknown) => app.fetch(new Request(`http://127.0.0.1${p}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(b) }));
  const get = (p: string) => app.fetch(new Request(`http://127.0.0.1${p}`));

  const created = await post("/api/sessions", { cwd, prompt: "reply with the single word ok" });
  expect(created.status).toBe(201);
  const { id } = (await created.json()) as { id: string };
  console.log("session", id);
  const r1 = await waitFor(app, id, "result", 0);
  expect((r1.data as { subtype: string }).subtype).toBe("success");

  const sent = await post(`/api/sessions/${id}/messages`, { text: "Use the Write tool to create a file named x.txt in the current directory containing exactly: hello" });
  expect((await sent.json()).delivered).toBe("stdin");
  const perm = await waitFor(app, id, "permission_request", r1.seq);
  const detail = (await (await get(`/api/sessions/${id}`)).json()) as { state: string; pending: Array<{ requestId: string; toolName: string }> };
  expect(detail.state).toBe("waiting_permission");
  expect(detail.pending.length).toBe(1);
  console.log("permission for", detail.pending[0]!.toolName);
  const answered = await post(`/api/sessions/${id}/permissions/${detail.pending[0]!.requestId}`, { behavior: "allow" });
  expect(answered.status).toBe(200);
  const r2 = await waitFor(app, id, "result", perm.seq);
  expect(existsSync(join(cwd, "x.txt"))).toBe(true);
  expect(readFileSync(join(cwd, "x.txt"), "utf8").trim()).toBe("hello");

  await post(`/api/sessions/${id}/messages`, { text: "Count from 1 to 300, one number per line, no tools." });
  await sleep(2500);
  expect((await post(`/api/sessions/${id}/interrupt`, {})).status).toBe(200);
  const r3 = await waitFor(app, id, "result", r2.seq);
  console.log("after interrupt:", (r3.data as { subtype: string }).subtype);

  expect((await app.fetch(new Request(`http://127.0.0.1/api/sessions/${id}`, { method: "DELETE" }))).status).toBe(204);
  const resumed = await post("/api/sessions", { cwd, resume: id, prompt: "Which file did you create earlier in this conversation? Reply with the file name only." });
  expect(resumed.status).toBe(201);
  const { id: id2 } = (await resumed.json()) as { id: string };
  console.log("resumed as", id2, id2 === id ? "(same id)" : "(new id)");
  const r4 = await waitFor(app, id2, "result", 0);
  const text = JSON.stringify(r4.data);
  expect(text).toContain("x.txt");
  await app.fetch(new Request(`http://127.0.0.1/api/sessions/${id2}`, { method: "DELETE" }));
}, 240000);
