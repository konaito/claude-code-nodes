import { test, expect } from "bun:test";
import { Relay, UnknownPeerError, PeerUnreachableError } from "../../src/relay/relay";
import { StaticRegistry } from "../../src/registry/registry";

const registry = new StaticRegistry([
  { name: "vm", url: "https://vm.cc.fybe.jp", status: "healthy", self: true },
  { name: "pro", url: "https://pro.cc.fybe.jp", status: "down", self: false },
]);
const token = { clientId: "cid", clientSecret: "csec" };
function fakeFetch(respond: (r: Request) => Response | Promise<Response>) {
  const calls: Request[] = [];
  const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => { const r = new Request(input, init); calls.push(r); return respond(r); }) as typeof fetch;
  return { fetchFn, calls };
}

test("forwards method, path, query and body with the service token and caller headers", async () => {
  const { fetchFn, calls } = fakeFetch(() => new Response(JSON.stringify({ ok: 1 }), { status: 201, headers: { "content-type": "application/json" } }));
  const relay = new Relay({ registry, nodeName: "vm", serviceToken: token, fetchFn });
  const req = new Request("https://vm.cc.fybe.jp/n/pro/api/sessions?x=1", { method: "POST", headers: { "content-type": "application/json", "x-cc-from": "forged" }, body: JSON.stringify({ cwd: "/a" }) });
  const res = await relay.forward("pro", "api/sessions", req, { id: "ceo@fybe.jp", kind: "user" });
  expect(res.status).toBe(201);
  expect(await res.json()).toEqual({ ok: 1 });
  const sent = calls[0]!;
  expect(sent.url).toBe("https://pro.cc.fybe.jp/api/sessions?x=1");
  expect(sent.method).toBe("POST");
  expect(await sent.json()).toEqual({ cwd: "/a" });
  expect(sent.headers.get("cf-access-client-id")).toBe("cid");
  expect(sent.headers.get("cf-access-client-secret")).toBe("csec");
  expect(sent.headers.get("x-cc-from")).toBe("ceo@fybe.jp");
  expect(sent.headers.get("x-cc-via")).toBe("vm");
  expect(sent.headers.get("content-type")).toBe("application/json");
});

test("keeps the caller's via when it already has one", async () => {
  const { fetchFn, calls } = fakeFetch(() => new Response("{}"));
  const relay = new Relay({ registry, nodeName: "vm", serviceToken: token, fetchFn });
  await relay.forward("pro", "api/host", new Request("https://vm.cc.fybe.jp/n/pro/api/host"), { id: "agent:lead", via: "mac", kind: "node" });
  expect(calls[0]!.headers.get("x-cc-via")).toBe("mac");
});

test("streams the upstream body and content-type back", async () => {
  const stream = new ReadableStream<Uint8Array>({ start(c) { c.enqueue(new TextEncoder().encode("event: a\ndata: 1\n\n")); c.close(); } });
  const { fetchFn } = fakeFetch(() => new Response(stream, { headers: { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache", "x-secret": "no" } }));
  const relay = new Relay({ registry, nodeName: "vm", serviceToken: token, fetchFn });
  const res = await relay.forward("pro", "api/sessions/s1/events", new Request("https://vm.cc.fybe.jp/n/pro/api/sessions/s1/events?after=0", { headers: { "last-event-id": "3" } }), { id: "ceo@fybe.jp" });
  expect(res.headers.get("content-type")).toContain("text/event-stream");
  expect(res.headers.get("x-secret")).toBeNull();
  expect(await res.text()).toBe("event: a\ndata: 1\n\n");
});

test("unknown peer is UnknownPeerError", async () => {
  const { fetchFn } = fakeFetch(() => new Response("{}"));
  const relay = new Relay({ registry, nodeName: "vm", serviceToken: token, fetchFn });
  await expect(relay.forward("nope", "api/host", new Request("https://vm.cc.fybe.jp/n/nope/api/host"), { id: "x" })).rejects.toBeInstanceOf(UnknownPeerError);
});

test("unreachable peer is PeerUnreachableError with the peer name", async () => {
  const { fetchFn } = fakeFetch(() => { throw new Error("ECONNREFUSED"); });
  const relay = new Relay({ registry, nodeName: "vm", serviceToken: token, fetchFn });
  const err = await relay.forward("pro", "api/host", new Request("https://vm.cc.fybe.jp/n/pro/api/host"), { id: "x" }).catch((e) => e);
  expect(err).toBeInstanceOf(PeerUnreachableError);
  expect((err as PeerUnreachableError).peer).toBe("pro");
});

test("no first byte within timeoutMs is PeerUnreachableError", async () => {
  const { fetchFn } = fakeFetch(() => new Promise(() => {}));
  const relay = new Relay({ registry, nodeName: "vm", serviceToken: token, fetchFn, timeoutMs: 30 });
  const err = await relay.forward("pro", "api/host", new Request("https://vm.cc.fybe.jp/n/pro/api/host"), { id: "x" }).catch((e) => e);
  expect(err).toBeInstanceOf(PeerUnreachableError);
});

test("a Cloudflare 5xx html page from the peer is PeerUnreachableError", async () => {
  const { fetchFn } = fakeFetch(() => new Response("<!doctype html><title>530</title>", { status: 530, headers: { "content-type": "text/html", "cf-ray": "abc" } }));
  const relay = new Relay({ registry, nodeName: "vm", serviceToken: token, fetchFn });
  const err = await relay.forward("pro", "api/host", new Request("https://vm.cc.fybe.jp/n/pro/api/host"), { id: "x" }).catch((e) => e);
  expect(err).toBeInstanceOf(PeerUnreachableError);
  expect((err as Error).message).toContain("530");
  const ok = fakeFetch(() => new Response(JSON.stringify({ error: "boom" }), { status: 500, headers: { "content-type": "application/json" } }));
  const r = await new Relay({ registry, nodeName: "vm", serviceToken: token, fetchFn: ok.fetchFn }).forward("pro", "api/host", new Request("https://vm.cc.fybe.jp/n/pro/api/host"), { id: "x" });
  expect(r.status).toBe(500);
});
