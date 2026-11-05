import { test, expect } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, statSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { main, type Ctx } from "../../src/cli/commands";
import { joinCommands, type JoinDeps } from "../../src/cli/join-commands";
import { encodeJoinToken, type JoinToken } from "../../src/join/token";
import { loadConfig, saveConfig, type Config } from "../../src/config";
import type { ServiceManager } from "../../src/join/services";

const tok: JoinToken = { v: 1, name: "vm", port: 4322, domain: "cc.fybe.jp", zone: "fybe.jp", teamDomain: "fybejp.cloudflareaccess.com", aud: "aud1", accountId: "acc", entry: "https://vm.cc.fybe.jp", tunnelToken: "TUNNEL-TOKEN", serviceToken: { clientId: "cid", clientSecret: "csec" }, cfApiToken: "CF-TOK" };

function world(over: Partial<JoinDeps> = {}, cfgOver: Partial<Config> = {}) {
  const home = mkdtempSync(join(tmpdir(), "cc-join-"));
  const configDir = join(home, ".config", "cc");
  const appDir = join(home, ".local", "share", "cc", "app");
  const calls: string[][] = [];
  const svc = { installs: 0, restarts: [] as string[], uninstalls: 0 };
  const services = (): ServiceManager => ({
    install: async () => { svc.installs++; }, uninstall: async () => { svc.uninstalls++; }, restart: async (k) => { svc.restarts.push(k); },
    status: async () => ({ node: "running", tunnel: "running" }),
  });
  const cf: JoinDeps["cf"] = async (args) => {
    calls.push(args);
    const out = (result: unknown) => ({ stdout: JSON.stringify({ result }), code: 0 });
    const key = args.slice(0, 4).join(" ");
    if (key.startsWith("zero-trust access applications list")) return out([]);
    if (key.startsWith("zero-trust access applications create")) return out({ id: "app-1", aud: "aud-created" });
    if (key.startsWith("zero-trust access service-tokens list")) return out([]);
    if (key.startsWith("zero-trust access service-tokens create")) return out({ id: "tok-1", client_id: "cid.new", client_secret: "csec.new" });
    if (key.startsWith("tunnels create")) return out({ id: "tun-1" });
    if (key.startsWith("tunnels list")) return out([{ id: "tun-1", name: "cc-vm" }]);
    if (key.startsWith("tunnels config update") || key.startsWith("dns records create")) return out({});
    if (key.startsWith("tunnels token get")) return out("TUNNEL-TOKEN");
    return { stdout: "", code: 1 };
  };
  const lines: string[] = [];
  const clip: string[] = [];
  const ttyLines: string[] = [];
  const runs: string[][] = [];
  const deps: JoinDeps = {
    cf, services, platform: "darwin", home, configDir, appDir, bunPath: "/bun", cloudflaredPath: "/cloudflared", uid: 501,
    tty: async () => "CF-FROM-TTY", ttyWrite: (s) => { ttyLines.push(s); }, clipboard: async (s) => { clip.push(s); return true; },
    run: async (cmd) => { runs.push(cmd); return { stdout: "", code: cmd[0] === "sh" ? 1 : 0 }; },
    now: () => new Date("2026-11-06T12:34:00"),
    ...over,
  };
  const fetchFn = (async (i: RequestInfo | URL) => new Response(new URL(new Request(i).url).pathname.endsWith("/events") ? "" : JSON.stringify({ name: "vm", claudeVersion: "2.1.318", id: "s1", pending: [], state: "idle", messages: [] }), { headers: { "content-type": "application/json" } })) as typeof fetch;
  const cfg: Config = { name: "pro", port: 4323, roots: [home], ...cfgOver };
  const ctx: Ctx = { cfg, env: { HOME: home }, out: (s) => lines.push(s), err: (s) => lines.push(`ERR ${s}`), fetchFn, stdin: async () => encodeJoinToken(tok), sendsPath: join(home, "sends.json"), join: joinCommands(deps) };
  return { home, configDir, appDir, ctx, lines, calls, clip, ttyLines, runs, svc, deps };
}

test("install writes cc.json and tunnel.token with 0600 and refuses a broken token before writing", async () => {
  const w = world();
  const bad = { ...w.ctx, stdin: async () => "not*a*token" };
  expect(await main(["install"], bad)).toBe(1);
  expect(existsSync(join(w.configDir, "cc.json"))).toBe(false);
  expect(w.svc.installs).toBe(0);
  const src = mkdtempSync(join(tmpdir(), "cc-src-"));
  mkdirSync(join(src, "skills", "session-inbox"), { recursive: true });
  writeFileSync(join(src, "skills", "session-inbox", "child.md"), "child");
  writeFileSync(join(src, "package.json"), '{"version":"0.0.1"}');
  mkdirSync(join(src, "bin")); writeFileSync(join(src, "bin", "cc"), "#!/bin/sh\n");
  expect(await main(["install", "--from", src], w.ctx)).toBe(0);
  expect(statSync(join(w.configDir, "cc.json")).mode & 0o777).toBe(0o600);
  expect(statSync(join(w.configDir, "tunnel.token")).mode & 0o777).toBe(0o600);
  expect(readFileSync(join(w.configDir, "tunnel.token"), "utf8")).toBe("TUNNEL-TOKEN");
  const cfg = loadConfig(join(w.configDir, "cc.json"));
  expect(cfg.name).toBe("vm");
  expect(cfg.serviceToken).toEqual({ clientId: "cid", clientSecret: "csec" });
  expect(cfg.cfApiToken).toBe("CF-TOK");
  expect(JSON.parse(readFileSync(join(w.home, ".claude", "settings.json"), "utf8"))).toEqual({ crossSessionInbound: "accept" });
  expect(readFileSync(join(w.home, ".config", "session-inbox", "child.md"), "utf8")).toBe("child");
  expect(existsSync(join(w.appDir, "package.json"))).toBe(true);
  expect(w.svc.installs).toBe(1);
  expect(w.lines.join("\n")).not.toContain("TUNNEL-TOKEN");
  expect(w.lines.join("\n")).not.toContain("csec");
});

test("install keeps the other keys of an existing settings.json and stops on an empty one", async () => {
  const w = world();
  mkdirSync(join(w.home, ".claude"), { recursive: true });
  writeFileSync(join(w.home, ".claude", "settings.json"), '{"model":"opus"}');
  const src = mkdtempSync(join(tmpdir(), "cc-src-"));
  writeFileSync(join(src, "package.json"), "{}");
  expect(await main(["install", "--from", src], w.ctx)).toBe(0);
  expect(JSON.parse(readFileSync(join(w.home, ".claude", "settings.json"), "utf8"))).toEqual({ model: "opus", crossSessionInbound: "accept" });
  const e = world();
  mkdirSync(join(e.home, ".claude"), { recursive: true });
  writeFileSync(join(e.home, ".claude", "settings.json"), "");
  expect(await main(["install", "--from", src], e.ctx)).toBe(1);
  expect(readFileSync(join(e.home, ".claude", "settings.json"), "utf8")).toBe("");
});

test("setup calls service token, access app, bypass app in order and saves aud", async () => {
  const w = world();
  expect(await main(["setup", "--hosts", "*.cc.fybe.jp", "--name", "konaito-pro", "--port", "4323"], w.ctx)).toBe(0);
  const heads = w.calls.map((c) => c.slice(0, 4).join(" "));
  expect(heads).toEqual([
    "zero-trust access service-tokens list", "zero-trust access service-tokens create",
    "zero-trust access applications list", "zero-trust access applications create",
    "zero-trust access applications list", "zero-trust access applications create",
  ]);
  const cfg = loadConfig(join(w.configDir, "cc.json"));
  expect(cfg).toEqual({ name: "konaito-pro", port: 4323, roots: [w.home], domain: "cc.fybe.jp", zone: "fybe.jp", teamDomain: "fybejp.cloudflareaccess.com", aud: "aud-created", accountId: "9b67e2ec0e2cf3359289e1fc860d3777", serviceToken: { clientId: "cid.new", clientSecret: "csec.new" }, cfApiToken: "CF-FROM-TTY" });
  expect(w.lines.join("\n")).not.toContain("csec.new");
});

test("node add never writes the token to stdout", async () => {
  const w = world();
  saveConfig({ name: "pro", port: 4323, roots: [w.home], domain: "cc.fybe.jp", zone: "fybe.jp", teamDomain: "t", aud: "a", accountId: "acc", entry: "https://vm.cc.fybe.jp", serviceToken: { clientId: "cid", clientSecret: "csec" }, cfApiToken: "CF" }, join(w.configDir, "cc.json"));
  expect(await main(["node", "add", "vm"], w.ctx)).toBe(0);
  expect(w.clip.length).toBe(1);
  expect(w.clip[0]).toMatch(/^[A-Za-z0-9_-]+$/);
  const all = w.lines.join("\n");
  expect(all).not.toContain(w.clip[0]!);
  expect(all).not.toContain("TUNNEL-TOKEN");
  expect(all).toContain("curl -fsSL https://vm.cc.fybe.jp/install | sh");
  expect(w.calls.map((c) => c.slice(0, 3).join(" "))).toEqual(["tunnels create --name", "tunnels config update", "dns records create", "tunnels token get"]);
  const noClip = world({ clipboard: async () => false });
  saveConfig(loadConfig(join(w.configDir, "cc.json")), join(noClip.configDir, "cc.json"));
  await main(["node", "add", "vm2"], noClip.ctx);
  expect(noClip.ttyLines.length).toBe(1);
});

test("node add refuses before setup", async () => {
  const w = world();
  expect(await main(["node", "add", "vm"], w.ctx)).toBe(1);
  expect(w.calls.length).toBe(0);
});

test("update swaps app.new into app and restarts node", async () => {
  const w = world();
  mkdirSync(w.appDir, { recursive: true });
  writeFileSync(join(w.appDir, "old.txt"), "old");
  saveConfig({ name: "vm", port: 4322, roots: [w.home], domain: "cc.fybe.jp", entry: "https://vm.cc.fybe.jp" }, join(w.configDir, "cc.json"));
  const src = mkdtempSync(join(tmpdir(), "cc-tar-"));
  writeFileSync(join(src, "package.json"), '{"version":"9.9.9"}');
  const tgz = await new Response(Bun.spawn(["tar", "czf", "-", "-C", src, "package.json"], { stdout: "pipe" }).stdout).arrayBuffer();
  const fetched: string[] = [];
  const ctx = { ...w.ctx, fetchFn: (async (i: RequestInfo | URL) => { fetched.push(new Request(i).url); return new Response(tgz, { headers: { "content-type": "application/gzip" } }); }) as typeof fetch };
  expect(await main(["update"], ctx)).toBe(0);
  expect(fetched).toEqual(["https://vm.cc.fybe.jp/install/cc.tar.gz"]);
  expect(readFileSync(join(w.appDir, "package.json"), "utf8")).toBe('{"version":"9.9.9"}');
  expect(existsSync(join(w.appDir, "old.txt"))).toBe(false);
  expect(existsSync(`${w.appDir}.new`)).toBe(false);
  expect(w.runs.some((r) => r[0] === "/bun" && r[1] === "install")).toBe(true);
  expect(w.svc.restarts).toEqual(["node"]);
});

test("uninstall removes services and the cc directories", async () => {
  const w = world();
  mkdirSync(w.appDir, { recursive: true });
  saveConfig({ name: "vm", port: 4322, roots: [] }, join(w.configDir, "cc.json"));
  expect(await main(["uninstall"], w.ctx)).toBe(0);
  expect(w.svc.uninstalls).toBe(1);
  expect(existsSync(w.configDir)).toBe(false);
  expect(existsSync(join(w.home, ".local", "share", "cc"))).toBe(false);
});

test("setup reads the CF API token from stdin with --cf-token-stdin and never prompts", async () => {
  const w = world({ tty: async () => { throw new Error("tty must not be used"); } });
  const ctx = { ...w.ctx, stdin: async () => "CF-FROM-STDIN\n" };
  expect(await main(["setup", "--hosts", "*.cc.fybe.jp", "--cf-token-stdin"], ctx)).toBe(0);
  expect(loadConfig(join(w.configDir, "cc.json")).cfApiToken).toBe("CF-FROM-STDIN");
  expect(w.lines.join("\n")).not.toContain("CF-FROM-STDIN");
});

test("node token re-issues the join token for an existing node", async () => {
  const w = world();
  saveConfig({ name: "pro", port: 4323, roots: [w.home], domain: "cc.fybe.jp", zone: "fybe.jp", teamDomain: "t", aud: "a", accountId: "acc", entry: "https://vm.cc.fybe.jp", serviceToken: { clientId: "cid", clientSecret: "csec" }, cfApiToken: "CF" }, join(w.configDir, "cc.json"));
  expect(await main(["node", "token", "vm", "--port", "4322"], w.ctx)).toBe(0);
  expect(w.calls.map((c) => c.slice(0, 3).join(" "))).toEqual(["tunnels list", "tunnels token get"]);
  expect(w.clip.length).toBe(1);
  expect(w.lines.join("\n")).not.toContain(w.clip[0]!);
});
