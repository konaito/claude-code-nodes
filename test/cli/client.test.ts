import { test, expect } from "bun:test";
import { agentName, clientFor, api, CliError } from "../../src/cli/client";
import type { Config } from "../../src/config";

const cfg: Config = { name: "pro", port: 4323, roots: ["/"], domain: "cc.fybe.jp", serviceToken: { clientId: "cid", clientSecret: "csec" } };
const env = { CLAUDE_CODE_SESSION_ID: "abcdef12-3456-7890-abcd-ef1234567890" };

test("agentName follows <node>/<sid8>/<role>", () => {
  expect(agentName("pro", env.CLAUDE_CODE_SESSION_ID, "lead")).toBe("pro/abcdef12/lead");
  expect(agentName("pro", undefined, undefined)).toBe("pro/parent");
  expect(agentName("pro", "zz", "a b/c")).toBe("pro/a-b/c");
});

test("clientFor targets localhost without a service token and peers with it", () => {
  const local = clientFor(cfg, undefined, "lead", env);
  expect(local.base).toBe("http://127.0.0.1:4323");
  expect(local.peer).toBe("pro");
  expect(local.headers).toEqual({ "x-cc-from": "agent:pro/abcdef12/lead", "x-cc-via": "pro" });
  expect(clientFor(cfg, "pro", "lead", env).base).toBe("http://127.0.0.1:4323");
  const remote = clientFor(cfg, "vm", undefined, env);
  expect(remote.base).toBe("https://vm.cc.fybe.jp");
  expect(remote.headers["cf-access-client-id"]).toBe("cid");
  expect(remote.headers["cf-access-client-secret"]).toBe("csec");
  expect(remote.headers["x-cc-from"]).toBe("agent:pro/abcdef12/parent");
  expect(() => clientFor({ name: "pro", port: 1, roots: [] }, "vm", undefined, env)).toThrow(CliError);
});

test("api parses json and turns non-2xx into CliError", async () => {
  const c = clientFor(cfg, undefined, undefined, env);
  const fetchFn = (async (i: RequestInfo | URL, init?: RequestInit) => {
    const r = new Request(i, init);
    if (r.url.endsWith("/api/host")) return new Response(JSON.stringify({ name: "pro" }), { headers: { "content-type": "application/json" } });
    if (r.method === "DELETE") return new Response(null, { status: 204 });
    return new Response(JSON.stringify({ error: "nope", hint: "resume" }), { status: 409 });
  }) as typeof fetch;
  expect(await api<{ name: string }>(c, "GET", "/api/host", undefined, fetchFn)).toEqual({ name: "pro" });
  expect(await api(c, "DELETE", "/api/sessions/x", undefined, fetchFn)).toBeUndefined();
  const err = await api(c, "POST", "/api/sessions/x/messages", { text: "hi" }, fetchFn).catch((e) => e);
  expect(err).toBeInstanceOf(CliError);
  expect((err as CliError).message).toContain("nope");
  expect((err as CliError).message).toContain("resume");
});
