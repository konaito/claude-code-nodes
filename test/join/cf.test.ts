import { test, expect } from "bun:test";
import { addNodeHost, ensureAccessApp, ensureBypassApp, ensureServiceToken, createNodeTunnel, removeNodeTunnel, renameNodeTunnel, setEntry, nodeTunnelToken, type CfRunner } from "../../src/join/cf";

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
    if (key.startsWith("tunnels edit")) return { stdout: "", code: 0 };
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

test("ensureBypassApp scopes each host to /install, /skill.md and /pwa with an everyone bypass", async () => {
  const f = fakeCf();
  await ensureBypassApp(f.cf, { name: "cc-install", hosts: ["*.cc.fybe.jp", "cc.fybe.jp"] });
  const b = f.body(1);
  expect(b.domain).toBe("*.cc.fybe.jp/install");
  expect(b.self_hosted_domains).toEqual(["*.cc.fybe.jp/install", "*.cc.fybe.jp/skill.md", "*.cc.fybe.jp/pwa", "cc.fybe.jp/install", "cc.fybe.jp/skill.md", "cc.fybe.jp/pwa"]);
  expect(b.policies).toEqual([{ name: "public", decision: "bypass", include: [{ everyone: {} }] }]);
});

test("updating an Access app keeps its Managed OAuth settings", async () => {
  const oauth = { enabled: true, dynamic_client_registration: { enabled: true, allow_any_on_localhost: true } };
  const f = fakeCf({ apps: [{ id: "app-1", name: "ccn", aud: "aud-1", oauth_configuration: oauth }] });
  await ensureAccessApp(f.cf, { name: "ccn", hosts: ["ccn-*.fybe.jp"], sessionDuration: "720h", email: "a@b", serviceTokenId: "tok" });
  const upd = f.calls.findIndex((c) => c.slice(0, 4).join(" ") === "zero-trust access applications update");
  expect(f.body(upd).oauth_configuration).toEqual(oauth);
  // 無ければ足さない
  const g = fakeCf({ apps: [{ id: "app-1", name: "ccn", aud: "aud-1" }] });
  await ensureAccessApp(g.cf, { name: "ccn", hosts: ["x"], sessionDuration: "720h", email: "a@b", serviceTokenId: "tok" });
  expect("oauth_configuration" in g.body(1)).toBe(false);
});

test("ensureServiceToken returns the secret only on create", async () => {
  const f = fakeCf();
  expect(await ensureServiceToken(f.cf, { name: "cc-node", duration: "8760h" })).toEqual({ id: "tok-1", name: "cc-node", clientId: "cid.access", clientSecret: "csec" });
  expect(f.body(1)).toEqual({ name: "cc-node", duration: "8760h" });
  const g = fakeCf({ tokens: [{ id: "tok-old", name: "cc-node", client_id: "cid.old" }] });
  expect(await ensureServiceToken(g.cf, { name: "cc-node", duration: "8760h" })).toEqual({ id: "tok-old", name: "cc-node", clientId: "cid.old" });
});

test("createNodeTunnel runs create, config, dns, token in order and never prints the token", async () => {
  const f = fakeCf();
  const r = await createNodeTunnel(f.cf, { name: "vm", hostname: "vm.cc.fybe.jp", port: 4322, zone: "fybe.jp" });
  expect(r).toEqual({ tunnelId: "tun-1", token: "TUNNEL-TOKEN" });
  expect(f.calls.map((c) => c.slice(0, 3).join(" "))).toEqual(["tunnels create --name", "tunnels config update", "dns records create", "tunnels token get"]);
  expect(f.calls[1]![3]).toBe("tun-1");
  expect(f.calls[0]).toContain("ccn-vm");
  expect(f.calls[0]).toContain("cloudflare");
  expect(f.body(1)).toEqual({ config: { ingress: [{ hostname: "vm.cc.fybe.jp", service: "http://127.0.0.1:4322" }, { service: "http_status:404" }] } });
  expect(f.calls[2]).toContain("fybe.jp");
  expect(f.body(2)).toEqual({ type: "CNAME", name: "vm.cc.fybe.jp", content: "tun-1.cfargotunnel.com", proxied: true });
  expect(JSON.stringify(f.calls)).not.toContain("TUNNEL-TOKEN");
});

test("removeNodeTunnel deletes dns before tunnel and ignores missing", async () => {
  const f = fakeCf({ tunnels: [{ id: "tun-1", name: "cc-vm" }], dns: [{ id: "dns-1", name: "vm.cc.fybe.jp", type: "CNAME" }] });
  await removeNodeTunnel(f.cf, { tunnelName: "cc-vm", hostname: "vm.cc.fybe.jp", zone: "fybe.jp" });
  const heads = f.calls.map((c) => c.slice(0, 3).join(" "));
  expect(heads.indexOf("dns records delete")).toBeLessThan(heads.indexOf("tunnels delete tun-1"));
  const g = fakeCf();
  await removeNodeTunnel(g.cf, { tunnelName: "cc-vm", hostname: "vm.cc.fybe.jp", zone: "fybe.jp" });
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
  await expect(nodeTunnelToken(f.cf, { name: "nope" })).rejects.toThrow(/ccn-nope/);
});

test("deletes pass --force because cf asks for confirmation otherwise", async () => {
  const f = fakeCf({ tunnels: [{ id: "tun-1", name: "cc-vm" }], dns: [{ id: "dns-1", name: "vm.cc.fybe.jp", type: "CNAME" }] });
  await removeNodeTunnel(f.cf, { tunnelName: "cc-vm", hostname: "vm.cc.fybe.jp", zone: "fybe.jp" });
  const deletes = f.calls.filter((c) => c.includes("delete"));
  expect(deletes.length).toBe(2);
  for (const c of deletes) expect(c).toContain("--force");
});

test("setup adopts the legacy-named Access app and service token instead of creating new ones", async () => {
  const f = fakeCf({ apps: [{ id: "app-old", name: "cc", aud: "aud-old" }], tokens: [{ id: "tok-old", name: "cc-node", client_id: "cid.old" }] });
  const tok = await ensureServiceToken(f.cf, { name: "ccn-node", legacyNames: ["cc-node"], duration: "8760h" });
  expect(tok).toEqual({ id: "tok-old", name: "cc-node", clientId: "cid.old" });
  const app = await ensureAccessApp(f.cf, { name: "ccn", legacyNames: ["cc"], hosts: ["ccn-*.fybe.jp", "ccn.fybe.jp", "cc-*.fybe.jp", "cc.fybe.jp"], sessionDuration: "720h", email: "a@b", serviceTokenId: tok.id });
  expect(app).toEqual({ id: "app-old", aud: "aud-old" });
  const upd = f.calls.findIndex((c) => c.slice(0, 4).join(" ") === "zero-trust access applications update");
  expect(f.calls[upd]![4]).toBe("app-old");
  expect(f.body(upd).name).toBe("ccn");
  expect(f.body(upd).self_hosted_domains).toEqual(["ccn-*.fybe.jp", "ccn.fybe.jp", "cc-*.fybe.jp", "cc.fybe.jp"]);
  expect(f.calls.some((c) => c.includes("create"))).toBe(false);
  // 新の名前が既にあれば、旧より新を選ぶ
  const g = fakeCf({ apps: [{ id: "app-old", name: "cc" }, { id: "app-new", name: "ccn" }] });
  expect((await ensureBypassApp(g.cf, { name: "ccn", legacyNames: ["cc"], hosts: ["x"] })).id).toBe("app-new");
});

test("node tunnels are found by the new name first, then by the legacy name", async () => {
  const both = fakeCf({ tunnels: [{ id: "tun-old", name: "cc-vm" }, { id: "tun-new", name: "ccn-vm" }] });
  expect((await nodeTunnelToken(both.cf, { name: "vm" })).tunnelId).toBe("tun-new");
  // remove は実名で1つに決めるので、旧を消すときに新を消さない
  const r = fakeCf({ tunnels: [{ id: "tun-old", name: "cc-vm" }, { id: "tun-new", name: "ccn-vm" }] });
  await removeNodeTunnel(r.cf, { tunnelName: "cc-vm", hostname: "cc-vm.fybe.jp", zone: "fybe.jp" });
  expect(r.calls.find((c) => c[0] === "tunnels" && c[1] === "delete")).toEqual(["tunnels", "delete", "tun-old", "--force"]);
});

test("addNodeHost adds the new hostname to a legacy tunnel's ingress and dns once, keeping the old one", async () => {
  const cfg = { config: { ingress: [{ hostname: "cc-vm.fybe.jp", service: "http://127.0.0.1:4322" }, { service: "http_status:404" }] } };
  const f = fakeCf({ tunnels: [{ id: "tun-1", name: "cc-vm" }], config: cfg });
  expect(await addNodeHost(f.cf, { name: "vm", hostname: "ccn-vm.fybe.jp", zone: "fybe.jp" })).toEqual({ ingress: true, dns: true });
  const upd = f.calls.findIndex((c) => c.slice(0, 3).join(" ") === "tunnels config update");
  expect(f.body(upd).config.ingress).toEqual([
    { hostname: "cc-vm.fybe.jp", service: "http://127.0.0.1:4322" },
    { hostname: "ccn-vm.fybe.jp", service: "http://127.0.0.1:4322" },
    { service: "http_status:404" },
  ]);
  const dns = f.calls.findIndex((c) => c.slice(0, 3).join(" ") === "dns records create");
  expect(f.body(dns)).toEqual({ type: "CNAME", name: "ccn-vm.fybe.jp", content: "tun-1.cfargotunnel.com", proxied: true });
  // 2回目は何もしない
  const again = fakeCf({ tunnels: [{ id: "tun-1", name: "cc-vm" }], config: { config: { ingress: [...cfg.config.ingress.slice(0, 1), { hostname: "ccn-vm.fybe.jp", service: "http://127.0.0.1:4322" }] } }, dns: [{ id: "d", name: "ccn-vm.fybe.jp", type: "CNAME" }] });
  expect(await addNodeHost(again.cf, { name: "vm", hostname: "ccn-vm.fybe.jp", zone: "fybe.jp" })).toEqual({ ingress: false, dns: false });
  expect(again.calls.some((c) => c.includes("update") || c.includes("create"))).toBe(false);
});

test("renameNodeTunnel renames cc-<name> to ccn-<name> with cf tunnels edit and is a no-op afterwards", async () => {
  const f = fakeCf({ tunnels: [{ id: "tun-1", name: "cc-vm" }] });
  expect(await renameNodeTunnel(f.cf, { name: "vm" })).toEqual({ renamed: true, from: "cc-vm" });
  expect(f.calls.at(-1)).toEqual(["tunnels", "edit", "tun-1", "--name", "ccn-vm"]);
  const g = fakeCf({ tunnels: [{ id: "tun-1", name: "ccn-vm" }] });
  expect(await renameNodeTunnel(g.cf, { name: "vm" })).toEqual({ renamed: false, from: "ccn-vm" });
  expect(g.calls.some((c) => c[1] === "edit")).toBe(false);
});

test("removeNodeTunnel with dnsOnly deletes the cname and keeps the tunnel", async () => {
  const f = fakeCf({ tunnels: [{ id: "tun-1", name: "cc-vm" }], dns: [{ id: "dns-1", name: "cc-vm.fybe.jp", type: "CNAME" }] });
  await removeNodeTunnel(f.cf, { tunnelName: "cc-vm", hostname: "cc-vm.fybe.jp", zone: "fybe.jp", dnsOnly: true });
  expect(f.calls.some((c) => c[0] === "tunnels" && c[1] === "delete")).toBe(false);
  expect(f.calls.some((c) => c.slice(0, 3).join(" ") === "dns records delete")).toBe(true);
});
