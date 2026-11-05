import { test, expect } from "bun:test";
import { ensureAccessApp, ensureBypassApp, ensureServiceToken, createNodeTunnel, removeNodeTunnel, setEntry, nodeTunnelToken, type CfRunner } from "../../src/join/cf";

// 偽の cf。args を記録し、コマンドの形で決まった JSON を返す
function fakeCf(state: { apps?: unknown[]; tokens?: unknown[]; tunnels?: unknown[]; dns?: unknown[]; config?: unknown } = {}) {
  const calls: string[][] = [];
  const cf: CfRunner = async (args) => {
    calls.push(args);
    const key = args.slice(0, 4).join(" ");
    const out = (result: unknown) => ({ stdout: JSON.stringify({ result }), code: 0 });
    if (key.startsWith("zero-trust access applications list")) return out(state.apps ?? []);
    if (key.startsWith("zero-trust access applications create")) return out({ id: "app-new", aud: "aud-new" });
    if (key.startsWith("zero-trust access applications update")) return out({ id: args[4], aud: "aud-old" });
    if (key.startsWith("zero-trust access service-tokens list")) return out(state.tokens ?? []);
    if (key.startsWith("zero-trust access service-tokens create")) return out({ id: "tok-1", client_id: "cid.access", client_secret: "csec" });
    if (key.startsWith("tunnels create")) return out({ id: "tun-1", name: "cc-vm" });
    if (key.startsWith("tunnels list")) return out(state.tunnels ?? []);
    if (key.startsWith("tunnels config get")) return out(state.config ?? { config: { ingress: [{ hostname: "vm.cc.fybe.jp", service: "http://127.0.0.1:4322" }, { service: "http_status:404" }] } });
    if (key.startsWith("tunnels config update")) return out({});
    if (key.startsWith("tunnels token get")) return out("TUNNEL-TOKEN");
    if (key.startsWith("tunnels delete")) return out({});
    if (key.startsWith("dns records list")) return out(state.dns ?? []);
    if (key.startsWith("dns records create")) return out({ id: "dns-1" });
    if (key.startsWith("dns records delete")) return out({});
    return { stdout: "", code: 1 };
  };
  const body = (i: number) => JSON.parse(calls[i]![calls[i]!.indexOf("--body") + 1]!);
  return { cf, calls, body };
}

test("ensureAccessApp creates with both policies when missing", async () => {
  const f = fakeCf();
  const r = await ensureAccessApp(f.cf, { name: "cc", hosts: ["*.cc.fybe.jp"], sessionDuration: "720h", email: "ceo@fybe.jp", serviceTokenId: "tok-1" });
  expect(r).toEqual({ id: "app-new", aud: "aud-new" });
  expect(f.calls[1]!.slice(0, 4)).toEqual(["zero-trust", "access", "applications", "create"]);
  const b = f.body(1);
  expect(b.name).toBe("cc");
  expect(b.type).toBe("self_hosted");
  expect(b.domain).toBe("*.cc.fybe.jp");
  expect(b.self_hosted_domains).toEqual(["*.cc.fybe.jp"]);
  expect(b.session_duration).toBe("720h");
  expect(b.policies[0].decision).toBe("allow");
  expect(b.policies[0].include).toEqual([{ email: { email: "ceo@fybe.jp" } }]);
  expect(b.policies[1].decision).toBe("non_identity");
  expect(b.policies[1].include).toEqual([{ service_token: { token_id: "tok-1" } }]);
});

test("ensureAccessApp updates by id when the name exists", async () => {
  const f = fakeCf({ apps: [{ id: "app-old", name: "cc", aud: "aud-old" }, { id: "x", name: "session-inbox" }] });
  const r = await ensureAccessApp(f.cf, { name: "cc", hosts: ["*.cc.fybe.jp", "cc.fybe.jp"], sessionDuration: "720h", email: "ceo@fybe.jp", serviceTokenId: "tok-1" });
  expect(r).toEqual({ id: "app-old", aud: "aud-old" });
  expect(f.calls[1]!.slice(0, 5)).toEqual(["zero-trust", "access", "applications", "update", "app-old"]);
  expect(f.body(1).self_hosted_domains).toEqual(["*.cc.fybe.jp", "cc.fybe.jp"]);
});

test("ensureBypassApp scopes hosts to /install with an everyone bypass", async () => {
  const f = fakeCf();
  await ensureBypassApp(f.cf, { name: "cc-install", hosts: ["*.cc.fybe.jp"] });
  const b = f.body(1);
  expect(b.domain).toBe("*.cc.fybe.jp/install");
  expect(b.self_hosted_domains).toEqual(["*.cc.fybe.jp/install"]);
  expect(b.policies).toEqual([{ name: "public", decision: "bypass", include: [{ everyone: {} }] }]);
});

test("ensureServiceToken returns the secret only on create", async () => {
  const f = fakeCf();
  expect(await ensureServiceToken(f.cf, { name: "cc-node", duration: "8760h" })).toEqual({ id: "tok-1", clientId: "cid.access", clientSecret: "csec" });
  expect(f.body(1)).toEqual({ name: "cc-node", duration: "8760h" });
  const g = fakeCf({ tokens: [{ id: "tok-old", name: "cc-node", client_id: "cid.old" }] });
  expect(await ensureServiceToken(g.cf, { name: "cc-node", duration: "8760h" })).toEqual({ id: "tok-old", clientId: "cid.old" });
});

test("createNodeTunnel runs create, config, dns, token in order and never prints the token", async () => {
  const f = fakeCf();
  const r = await createNodeTunnel(f.cf, { name: "vm", hostname: "vm.cc.fybe.jp", port: 4322, zone: "fybe.jp" });
  expect(r).toEqual({ tunnelId: "tun-1", token: "TUNNEL-TOKEN" });
  expect(f.calls.map((c) => c.slice(0, 3).join(" "))).toEqual(["tunnels create --name", "tunnels config update", "dns records create", "tunnels token get"]);
  expect(f.calls[1]![3]).toBe("tun-1");
  expect(f.calls[0]).toContain("cc-vm");
  expect(f.calls[0]).toContain("cloudflare");
  expect(f.body(1)).toEqual({ config: { ingress: [{ hostname: "vm.cc.fybe.jp", service: "http://127.0.0.1:4322" }, { service: "http_status:404" }] } });
  expect(f.calls[2]).toContain("fybe.jp");
  expect(f.body(2)).toEqual({ type: "CNAME", name: "vm.cc.fybe.jp", content: "tun-1.cfargotunnel.com", proxied: true });
  expect(JSON.stringify(f.calls)).not.toContain("TUNNEL-TOKEN");
});

test("removeNodeTunnel deletes dns before tunnel and ignores missing", async () => {
  const f = fakeCf({ tunnels: [{ id: "tun-1", name: "cc-vm" }], dns: [{ id: "dns-1", name: "vm.cc.fybe.jp", type: "CNAME" }] });
  await removeNodeTunnel(f.cf, { name: "vm", hostname: "vm.cc.fybe.jp", zone: "fybe.jp" });
  const heads = f.calls.map((c) => c.slice(0, 3).join(" "));
  expect(heads.indexOf("dns records delete")).toBeLessThan(heads.indexOf("tunnels delete tun-1"));
  const g = fakeCf();
  await removeNodeTunnel(g.cf, { name: "vm", hostname: "vm.cc.fybe.jp", zone: "fybe.jp" });
  expect(g.calls.map((c) => c.slice(0, 3).join(" "))).not.toContain("tunnels delete");
});

test("setEntry appends the entry hostname to the ingress and points the cname", async () => {
  const f = fakeCf({ tunnels: [{ id: "tun-1", name: "cc-incertotech" }] });
  await setEntry(f.cf, { name: "incertotech", entryHost: "cc.fybe.jp", port: 4322, zone: "fybe.jp" });
  const upd = f.calls.findIndex((c) => c.slice(0, 3).join(" ") === "tunnels config update");
  expect(f.body(upd).config.ingress).toEqual([
    { hostname: "vm.cc.fybe.jp", service: "http://127.0.0.1:4322" },
    { hostname: "cc.fybe.jp", service: "http://127.0.0.1:4322" },
    { service: "http_status:404" },
  ]);
  const dns = f.calls.findIndex((c) => c.slice(0, 3).join(" ") === "dns records create");
  expect(f.body(dns)).toEqual({ type: "CNAME", name: "cc.fybe.jp", content: "tun-1.cfargotunnel.com", proxied: true });
});

test("nodeTunnelToken re-reads the token of an existing tunnel without creating one", async () => {
  const f = fakeCf({ tunnels: [{ id: "tun-1", name: "cc-vm" }] });
  expect(await nodeTunnelToken(f.cf, { name: "vm" })).toEqual({ tunnelId: "tun-1", token: "TUNNEL-TOKEN" });
  expect(f.calls.map((c) => c.slice(0, 3).join(" "))).toEqual(["tunnels list", "tunnels token get"]);
  await expect(nodeTunnelToken(f.cf, { name: "nope" })).rejects.toThrow(/cc-nope/);
});
