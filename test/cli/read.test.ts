import { test, expect } from "bun:test";
import { readUntilResult } from "../../src/cli/read";
import { api, request, CliError, type Client } from "../../src/cli/client";
import type { SessionSummary } from "../../src/sessions/types";

const c: Client = { peer: "vm", base: "https://ccn-vm.example", headers: {}, retryMs: [0, 0, 0] };
const s: SessionSummary = { id: "s1", kind: "node", capabilities: { send: true, permissions: true, interrupt: true, stop: true, events: true }, cwd: "/", state: "running", startedAt: 0, lastActivityAt: 0 };
const ev = (seq: number, event: string, data: unknown) => `id: ${seq}\nevent: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
const assistant = (text: string) => ({ type: "assistant", message: { content: [{ type: "text", text }] } });
const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status, headers: { "content-type": "application/json" } });
const noSleep = { sleep: async () => {}, retryMs: 1 };

// 先頭の文字列を流したあと、例外で切れる本文（トンネルの瞬断）
function cutStream(text: string): ReadableStream<Uint8Array> {
  let sent = false;
  return new ReadableStream({
    pull(ctl) {
      if (!sent) { sent = true; ctl.enqueue(new TextEncoder().encode(text)); return; }
      ctl.error(new TypeError("socket closed"));
    },
  });
}

// /events への応答を順に返し、呼ばれた URL を控える偽のノード
function node(events: Array<() => Response>, detail: Record<string, unknown> = { state: "idle", pending: [] }) {
  const urls: string[] = [];
  let i = 0;
  const fetchFn = (async (u: RequestInfo | URL) => {
    const url = new Request(u).url;
    urls.push(url);
    if (url.includes("/events")) return (events[Math.min(i++, events.length - 1)]!)();
    return json({ ...s, ...detail });
  }) as typeof fetch;
  return { urls, fetchFn, eventUrls: () => urls.filter((x) => x.includes("/events")) };
}

test("read reconnects from the last seq when the stream is cut and still reaches the result", async () => {
  const n = node([
    () => new Response(cutStream(ev(4, "assistant", assistant("first")) + "id: 5\nevent: assis"), { headers: { "content-type": "text/event-stream" } }),
    () => new Response(ev(5, "assistant", assistant("second")) + ev(6, "result", { subtype: "success" }), { headers: { "content-type": "text/event-stream" } }),
  ]);
  const lines: string[] = [];
  const r = await readUntilResult(c, s, 3, 60, (l) => lines.push(l), { fetchFn: n.fetchFn, ...noSleep });
  expect(r).toEqual({ code: 0, seq: 6 });
  expect(n.eventUrls()).toEqual(["https://ccn-vm.example/api/sessions/s1/events?after=3", "https://ccn-vm.example/api/sessions/s1/events?after=4"]);
  expect(lines.filter((l) => l === "first" || l === "second")).toEqual(["first", "second"]); // 切れ端の枠は出さない
  expect(lines.some((l) => l.startsWith("[reconnect]") && l.includes("seq=4"))).toBe(true);
  expect(lines.at(-1)).toBe("state=idle pending=0 seq=6");
});

test("read retries a 530 and a network error on the events stream", async () => {
  const n = node([
    () => new Response("error code: 530", { status: 530 }),
    () => { throw new TypeError("fetch failed"); },
    () => new Response(ev(2, "result", {}), { headers: { "content-type": "text/event-stream" } }),
  ]);
  const lines: string[] = [];
  const r = await readUntilResult(c, s, 1, 60, (l) => lines.push(l), { fetchFn: n.fetchFn, ...noSleep });
  expect(r.code).toBe(0);
  expect(n.eventUrls().length).toBe(3);
  expect(lines.filter((l) => l.startsWith("[reconnect]")).length).toBe(2); // 理由が変わるたびに1行
});

test("read prints one line for a gap and keeps reading", async () => {
  const n = node([() => new Response(`event: gap\ndata: ${JSON.stringify({ from: 1, to: 9 })}\n\n` + ev(10, "result", {}), { headers: { "content-type": "text/event-stream" } })]);
  const lines: string[] = [];
  const r = await readUntilResult(c, s, 0, 60, (l) => lines.push(l), { fetchFn: n.fetchFn, ...noSleep });
  expect(r).toEqual({ code: 0, seq: 10 });
  expect(lines.filter((l) => l.startsWith("[gap]"))).toEqual(["[gap] seq 1..9 はノードの上限を超えて捨てられ、読めなかった"]);
});

test("read stops without waiting when the stream closes and the session has exited", async () => {
  const n = node([() => new Response("", { headers: { "content-type": "text/event-stream" } })], { state: "exited", pending: [] });
  let slept = 0;
  const r = await readUntilResult(c, s, 0, 600, () => {}, { fetchFn: n.fetchFn, sleep: async () => { slept++; }, retryMs: 1 });
  expect(r.code).toBe(4);
  expect(slept).toBe(0);
  expect(n.eventUrls().length).toBe(1);
});

test("read reconnects after a clean close while the session is still running, until the deadline", async () => {
  let t = 0;
  const n = node([() => new Response("", { headers: { "content-type": "text/event-stream" } })], { state: "running", pending: [] });
  const r = await readUntilResult(c, s, 7, 10, () => {}, { fetchFn: n.fetchFn, now: () => t, sleep: async (ms) => { t += ms; }, retryMs: 1000 });
  expect(r).toEqual({ code: 2, seq: 7 });
  // 1、2、4 秒と間を空け、10 秒の締め切りで止まる
  expect(n.eventUrls().length).toBe(4);
});

test("read gives up on 404 and fails on 401 instead of reconnecting", async () => {
  const gone = node([() => json({ error: "no live session" }, 404)], { state: "exited", pending: [] });
  expect((await readUntilResult(c, s, 0, 60, () => {}, { fetchFn: gone.fetchFn, ...noSleep })).code).toBe(4);
  expect(gone.eventUrls().length).toBe(1);
  const denied = node([() => json({ error: "access token required" }, 401)]);
  const err = await readUntilResult(c, s, 0, 60, () => {}, { fetchFn: denied.fetchFn, ...noSleep }).catch((e) => e);
  expect(err).toBeInstanceOf(CliError);
  expect(denied.eventUrls().length).toBe(1);
});

test("GET retries 502, 530 and network errors; POST is sent once", async () => {
  const seen: string[] = [];
  let n = 0;
  const flaky = (async (u: RequestInfo | URL, init?: RequestInit) => {
    const r = new Request(u, init);
    seen.push(r.method);
    n++;
    if (n === 1) return new Response("bad gateway", { status: 502 });
    if (n === 2) throw new TypeError("fetch failed");
    if (n === 3) return new Response("error code: 530", { status: 530 });
    return json({ ok: true });
  }) as typeof fetch;
  expect(await api<{ ok: boolean }>(c, "GET", "/api/host", undefined, flaky)).toEqual({ ok: true });
  expect(seen).toEqual(["GET", "GET", "GET", "GET"]);
  seen.length = 0; n = 0;
  const err = await api(c, "POST", "/api/sessions/s1/messages", { text: "hi" }, flaky).catch((e) => e);
  expect(err).toBeInstanceOf(CliError);
  expect(seen).toEqual(["POST"]);
  // やり直しの回数を使い切ったら最後の応答を返す
  const always = (async () => new Response("x", { status: 530 })) as unknown as typeof fetch;
  expect((await request(c, "GET", "/api/host", undefined, always)).status).toBe(530);
});
