import { test, expect } from "bun:test";
import { AccessIdentity } from "../../src/identity/access";
import { AccessDenied } from "../../src/identity/identity";
import { makeKeys } from "../helpers/jwt";

const TEAM = "fybejp.cloudflareaccess.com";
const AUD = "aud-1";
const now = 1_800_000_000; // 秒
const claims = (extra: Record<string, unknown>) => ({ aud: [AUD], iss: `https://${TEAM}`, iat: now - 60, exp: now + 3600, sub: "s", ...extra });

async function setup() {
  const keys = await makeKeys();
  let fetches = 0;
  const id = new AccessIdentity({ teamDomain: TEAM, aud: AUD, fetchJwks: async () => { fetches++; return keys.jwks; }, now: () => now * 1000 });
  const reqWith = (token: string | undefined, headers: Record<string, string> = {}) =>
    new Request("http://127.0.0.1/api/x", { headers: { ...(token ? { "cf-access-jwt-assertion": token } : {}), ...headers } });
  return { keys, id, reqWith, fetches: () => fetches };
}

test("email jwt yields the email and drops x-cc-from", async () => {
  const { keys, id, reqWith } = await setup();
  const tok = await keys.sign(claims({ email: "ceo@fybe.jp" }));
  expect(await id.callerOf(reqWith(tok, { "x-cc-from": "agent:x", "x-cc-via": "evil" }))).toEqual({ id: "ceo@fybe.jp", kind: "user" });
});

test("service token jwt accepts x-cc-from and x-cc-via", async () => {
  const { keys, id, reqWith } = await setup();
  const tok = await keys.sign(claims({ common_name: "cc-node" }));
  expect(await id.callerOf(reqWith(tok, { "x-cc-from": "agent:lead", "x-cc-via": "vm" }))).toEqual({ id: "agent:lead", via: "vm", kind: "node" });
});

test("service token jwt without headers names the token", async () => {
  const { keys, id, reqWith } = await setup();
  const tok = await keys.sign(claims({ common_name: "cc-node" }));
  expect(await id.callerOf(reqWith(tok))).toEqual({ id: "agent:cc-node", kind: "node" });
});

test("wrong aud, expired and foreign signature are 403", async () => {
  const { keys, id, reqWith } = await setup();
  const other = await makeKeys("k1");
  for (const tok of [
    await keys.sign(claims({ email: "ceo@fybe.jp", aud: ["other"] })),
    await keys.sign(claims({ email: "ceo@fybe.jp", exp: now - 1 })),
    await other.sign(claims({ email: "ceo@fybe.jp" })),
    await keys.sign(claims({ email: "ceo@fybe.jp", iss: "https://evil.example" })),
  ]) {
    const err = await id.callerOf(reqWith(tok)).catch((e) => e);
    expect(err).toBeInstanceOf(AccessDenied);
    expect((err as AccessDenied).status).toBe(403);
  }
});

test("jwt with neither email nor common_name is 403", async () => {
  const { keys, id, reqWith } = await setup();
  const err = await id.callerOf(reqWith(await keys.sign(claims({})))).catch((e) => e);
  expect((err as AccessDenied).status).toBe(403);
});

test("through cloudflare without a token is 401", async () => {
  const { id, reqWith } = await setup();
  const err = await id.callerOf(reqWith(undefined, { "cf-connecting-ip": "1.2.3.4", "x-cc-from": "agent:x" })).catch((e) => e);
  expect(err).toBeInstanceOf(AccessDenied);
  expect((err as AccessDenied).status).toBe(401);
});

test("plain local request falls back to headers", async () => {
  const { id, reqWith } = await setup();
  expect(await id.callerOf(reqWith(undefined, { "x-cc-from": "agent:lead" }))).toEqual({ id: "agent:lead", kind: "local" });
  expect(await id.callerOf(reqWith(undefined))).toEqual({ id: "local", kind: "local" });
});

test("token in the CF_Authorization cookie also works", async () => {
  const { keys, id } = await setup();
  const tok = await keys.sign(claims({ email: "ceo@fybe.jp" }));
  const req = new Request("http://127.0.0.1/", { headers: { cookie: `a=b; CF_Authorization=${tok}` } });
  expect(await id.callerOf(req)).toEqual({ id: "ceo@fybe.jp", kind: "user" });
});

test("unknown kid refetches the jwks once", async () => {
  const { keys, id, reqWith, fetches } = await setup();
  await id.callerOf(reqWith(await keys.sign(claims({ email: "ceo@fybe.jp" }))));
  expect(fetches()).toBe(1);
  const err = await id.callerOf(reqWith(await keys.sign(claims({ email: "ceo@fybe.jp" }), { kid: "k9" }))).catch((e) => e);
  expect((err as AccessDenied).status).toBe(403);
  expect(fetches()).toBe(2);
});

test("a request without a JWT for a non-loopback host is 401 (DNS rebinding)", async () => {
  const { id } = await setup();
  const err = await id.callerOf(new Request("http://evil.example:4322/api/sessions")).catch((e) => e);
  expect(err).toBeInstanceOf(AccessDenied);
  expect((err as AccessDenied).status).toBe(401);
  for (const h of ["http://127.0.0.1:4322/api/x", "http://localhost:4322/api/x", "http://[::1]:4322/api/x"]) {
    expect((await id.callerOf(new Request(h))).kind).toBe("local");
  }
});
