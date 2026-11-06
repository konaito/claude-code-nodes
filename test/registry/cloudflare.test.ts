import { test, expect } from "bun:test";
import { CloudflareRegistry } from "../../src/registry/cloudflare";
import { RegistryError } from "../../src/registry/registry";

const tunnels = [
  { id: "t1", name: "cc-vm", status: "healthy" },
  { id: "t2", name: "air", status: "down" },
  { id: "t3", name: "cc-pro", status: "down" },
];
function fakeFetch(status = 200, body: unknown = { result: tunnels }) {
  const calls: Request[] = [];
  const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push(new Request(input, init));
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  return { fetchFn, calls };
}
const deps = (fetchFn: typeof fetch, extra = {}) => ({ accountId: "acc", apiToken: "tok", zone: "fybe.jp", selfName: "pro", fetchFn, ...extra });

test("maps cc- tunnels to peers with urls and marks self", async () => {
  const { fetchFn } = fakeFetch();
  const peers = await new CloudflareRegistry(deps(fetchFn)).peers();
  expect(peers).toEqual([
    { name: "pro", url: "https://cc-pro.fybe.jp", status: "down", self: true },
    { name: "vm", url: "https://cc-vm.fybe.jp", status: "healthy", self: false },
  ]);
});

test("sends the bearer token and the is_deleted filter", async () => {
  const { fetchFn, calls } = fakeFetch();
  await new CloudflareRegistry(deps(fetchFn)).peers();
  const u = new URL(calls[0]!.url);
  expect(u.pathname).toBe("/client/v4/accounts/acc/cfd_tunnel");
  expect(u.searchParams.get("is_deleted")).toBe("false");
  expect(calls[0]!.headers.get("authorization")).toBe("Bearer tok");
});

test("caches within cacheMs", async () => {
  const { fetchFn, calls } = fakeFetch();
  let t = 0;
  const r = new CloudflareRegistry(deps(fetchFn, { cacheMs: 10000, now: () => t }));
  await r.peers(); await r.peers();
  expect(calls.length).toBe(1);
  t = 20000;
  await r.peers();
  expect(calls.length).toBe(2);
});

test("non-2xx becomes RegistryError 502", async () => {
  const { fetchFn } = fakeFetch(403, { errors: [{ message: "nope" }] });
  const err = await new CloudflareRegistry(deps(fetchFn)).peers().catch((e) => e);
  expect(err).toBeInstanceOf(RegistryError);
  expect((err as RegistryError).status).toBe(502);
});
