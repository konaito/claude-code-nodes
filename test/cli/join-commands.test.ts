import { test, expect } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, statSync, existsSync, symlinkSync, readlinkSync, lstatSync, rmSync } from "node:fs";
import { decodeJoinToken } from "../../src/join/token";
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
  const configDir = join(home, ".config", "ccn");
  const appDir = join(home, ".local", "share", "ccn", "app");
  const calls: string[][] = [];
  const svc = { installs: 0, restarts: [] as string[], uninstalls: 0, legacyUninstalls: 0 };
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
    cf, services, legacyServices: () => ({ ...services(), uninstall: async () => { svc.legacyUninstalls++; } }), platform: "darwin", home, configDir, appDir, bunPath: "/bun", cloudflaredPath: "/cloudflared", uid: 501,
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
  expect(existsSync(join(w.configDir, "ccn.json"))).toBe(false);
  expect(w.svc.installs).toBe(0);
  const src = mkdtempSync(join(tmpdir(), "cc-src-"));
  mkdirSync(join(src, "skills", "ccn"), { recursive: true });
  writeFileSync(join(src, "skills", "ccn", "child.md"), "child");
  writeFileSync(join(src, "package.json"), '{"version":"0.0.1"}');
  mkdirSync(join(src, "bin")); writeFileSync(join(src, "bin", "ccn"), "#!/bin/sh\n");
  expect(await main(["install", "--from", src], w.ctx)).toBe(0);
  expect(statSync(join(w.configDir, "ccn.json")).mode & 0o777).toBe(0o600);
  expect(statSync(join(w.configDir, "tunnel.token")).mode & 0o777).toBe(0o600);
  expect(readFileSync(join(w.configDir, "tunnel.token"), "utf8")).toBe("TUNNEL-TOKEN");
  const cfg = loadConfig(join(w.configDir, "ccn.json"));
  expect(cfg.name).toBe("vm");
  expect(cfg.serviceToken).toEqual({ clientId: "cid", clientSecret: "csec" });
  expect(cfg.cfApiToken).toBe("CF-TOK");
  expect(JSON.parse(readFileSync(join(w.home, ".claude", "settings.json"), "utf8"))).toEqual({ crossSessionInbound: "accept" });
  expect(readFileSync(join(w.home, ".config", "ccn", "child.md"), "utf8")).toBe("child");
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

const SETUP = ["--email", "owner@example.com", "--domain", "ccn.example.com", "--zone", "example.com", "--team-domain", "team.cloudflareaccess.com", "--account-id", "acc-test"];

test("setup calls service token, access app, bypass app in order and saves aud", async () => {
  const w = world();
  expect(await main(["setup", "--hosts", "*.cc.fybe.jp", ...SETUP, "--name", "konaito-pro", "--port", "4323"], w.ctx)).toBe(0);
  const heads = w.calls.map((c) => c.slice(0, 4).join(" "));
  expect(heads).toEqual([
    "zero-trust access service-tokens list", "zero-trust access service-tokens create",
    "zero-trust access applications list", "zero-trust access applications create",
    "zero-trust access applications list", "zero-trust access applications create",
  ]);
  const cfg = loadConfig(join(w.configDir, "ccn.json"));
  expect(cfg).toEqual({ name: "konaito-pro", port: 4323, roots: [w.home], domain: "ccn.example.com", zone: "example.com", teamDomain: "team.cloudflareaccess.com", aud: "aud-created", accountId: "acc-test", serviceToken: { clientId: "cid.new", clientSecret: "csec.new" }, cfApiToken: "CF-FROM-TTY" });
  expect(w.lines.join("\n")).not.toContain("csec.new");
});

test("node add never writes the token to stdout", async () => {
  const w = world();
  saveConfig({ name: "pro", port: 4323, roots: [w.home], domain: "cc.fybe.jp", zone: "fybe.jp", teamDomain: "t", aud: "a", accountId: "acc", entry: "https://vm.cc.fybe.jp", serviceToken: { clientId: "cid", clientSecret: "csec" }, cfApiToken: "CF" }, join(w.configDir, "ccn.json"));
  expect(await main(["node", "add", "vm"], w.ctx)).toBe(0);
  expect(w.clip.length).toBe(1);
  expect(w.clip[0]).toMatch(/^[A-Za-z0-9_-]+$/);
  const all = w.lines.join("\n");
  expect(all).not.toContain(w.clip[0]!);
  expect(all).not.toContain("TUNNEL-TOKEN");
  expect(all).toContain("curl -fsSL https://vm.cc.fybe.jp/install | sh");
  expect(w.calls.map((c) => c.slice(0, 3).join(" "))).toEqual(["tunnels create --name", "tunnels config update", "dns records create", "tunnels token get"]);
  const dns = w.calls.find((c) => c.slice(0, 3).join(" ") === "dns records create")!;
  expect(JSON.parse(dns[dns.indexOf("--body") + 1]!).name).toBe("ccn-vm.fybe.jp");
  const noClip = world({ clipboard: async () => false });
  saveConfig(loadConfig(join(w.configDir, "ccn.json")), join(noClip.configDir, "ccn.json"));
  await main(["node", "add", "vm2"], noClip.ctx);
  expect(noClip.ttyLines.length).toBe(1);
});

test("node add refuses before setup", async () => {
  const w = world();
  expect(await main(["node", "add", "vm"], w.ctx)).toBe(1);
  expect(w.calls.length).toBe(0);
});

test("setup has no built-in Cloudflare or Access values and names the missing flag before calling cf", async () => {
  const w = world();
  for (const [drop, flag] of [["--email", "email"], ["--account-id", "account-id"], ["--team-domain", "team-domain"]] as const) {
    const i = SETUP.indexOf(drop);
    const args = [...SETUP.slice(0, i), ...SETUP.slice(i + 2)];
    w.lines.length = 0;
    expect(await main(["setup", "--hosts", "*.example.com", ...args], w.ctx)).toBe(1);
    expect(w.lines.join("\n")).toContain(`--${flag} が要る`);
  }
  expect(w.calls).toEqual([]);
});

test("setup takes domain, zone, team domain and account id from the saved config on later runs, but always wants --email", async () => {
  const w = world();
  saveConfig({ name: "vm", port: 4322, roots: [w.home], domain: "ccn.example.com", zone: "example.com", teamDomain: "team.cloudflareaccess.com", accountId: "acc-saved" }, join(w.configDir, "ccn.json"));
  expect(await main(["setup", "--hosts", "*.example.com"], w.ctx)).toBe(1);
  expect(w.lines.join("\n")).toContain("--email が要る");
  expect(await main(["setup", "--hosts", "*.example.com", "--email", "owner@example.com"], w.ctx)).toBe(0);
  const cfg = loadConfig(join(w.configDir, "ccn.json"));
  expect([cfg.domain, cfg.zone, cfg.teamDomain, cfg.accountId]).toEqual(["ccn.example.com", "example.com", "team.cloudflareaccess.com", "acc-saved"]);
});

test("update swaps app.new into app and restarts node", async () => {
  const w = world();
  mkdirSync(w.appDir, { recursive: true });
  writeFileSync(join(w.appDir, "old.txt"), "old");
  saveConfig({ name: "vm", port: 4322, roots: [w.home], domain: "cc.fybe.jp", entry: "https://vm.cc.fybe.jp" }, join(w.configDir, "ccn.json"));
  const src = mkdtempSync(join(tmpdir(), "cc-tar-"));
  writeFileSync(join(src, "package.json"), '{"version":"9.9.9"}');
  const tgz = await new Response(Bun.spawn(["tar", "czf", "-", "-C", src, "package.json"], { stdout: "pipe" }).stdout).arrayBuffer();
  const fetched: string[] = [];
  const ctx = { ...w.ctx, fetchFn: (async (i: RequestInfo | URL) => { fetched.push(new Request(i).url); return new Response(tgz, { headers: { "content-type": "application/gzip" } }); }) as typeof fetch };
  expect(await main(["update"], ctx)).toBe(0);
  expect(fetched).toEqual(["https://vm.cc.fybe.jp/install/ccn.tar.gz"]);
  expect(readFileSync(join(w.appDir, "package.json"), "utf8")).toBe('{"version":"9.9.9"}');
  expect(existsSync(join(w.appDir, "old.txt"))).toBe(false);
  expect(existsSync(`${w.appDir}.new`)).toBe(false);
  expect(w.runs.some((r) => r[0] === "/bun" && r[1] === "install")).toBe(true);
  expect(w.svc.restarts).toEqual(["node"]);
});

const isLink = (p: string) => { try { return lstatSync(p).isSymbolicLink(); } catch { return false; } };
// macOS には /usr/bin/cc が必ずある。CLI の名前（ccn）はそれと被らないので、リンクは必ず置く
const macRun = (runs: string[][]): JoinDeps["run"] => async (cmd) => {
  runs.push(cmd);
  if (cmd[0] === "sh") return / cc$/.test(cmd[2] ?? "") ? { stdout: "/usr/bin/cc\n", code: 0 } : { stdout: "", code: 1 };
  return { stdout: "", code: 0 };
};
function bundleSrc(child = "child") {
  const src = mkdtempSync(join(tmpdir(), "cc-src-"));
  mkdirSync(join(src, "skills", "ccn"), { recursive: true });
  writeFileSync(join(src, "skills", "ccn", "child.md"), child);
  writeFileSync(join(src, "package.json"), '{"version":"9.9.9"}');
  mkdirSync(join(src, "bin")); writeFileSync(join(src, "bin", "ccn"), "#!/bin/sh\n");
  return src;
}

test("install links ~/.local/bin/ccn on a Mac that has /usr/bin/cc and drops the old cc link into the app", async () => {
  const runs: string[][] = [];
  const w = world({ run: macRun(runs) });
  const bin = join(w.home, ".local", "bin");
  mkdirSync(bin, { recursive: true });
  symlinkSync(join(w.appDir, "bin", "cc"), join(bin, "cc"));
  expect(await main(["install", "--from", bundleSrc()], w.ctx)).toBe(0);
  expect(readlinkSync(join(bin, "ccn"))).toBe(join(w.appDir, "bin", "ccn"));
  expect(isLink(join(bin, "cc"))).toBe(false);
});

test("update --from <dir> installs that checkout, relinks ccn and refreshes child.md", async () => {
  const runs: string[][] = [];
  const w = world({ run: macRun(runs) });
  mkdirSync(w.appDir, { recursive: true });
  writeFileSync(join(w.appDir, "old.txt"), "old");
  saveConfig({ name: "vm", port: 4322, roots: [w.home], domain: "cc.fybe.jp" }, join(w.configDir, "ccn.json"));
  mkdirSync(join(w.home, ".config", "ccn"), { recursive: true });
  writeFileSync(join(w.home, ".config", "ccn", "child.md"), "old child");
  const ctx = { ...w.ctx, fetchFn: (async () => { throw new Error("must not fetch"); }) as unknown as typeof fetch };
  expect(await main(["update", "--from", bundleSrc("new child")], ctx)).toBe(0);
  expect(readFileSync(join(w.appDir, "package.json"), "utf8")).toBe('{"version":"9.9.9"}');
  expect(existsSync(join(w.appDir, "old.txt"))).toBe(false);
  expect(readlinkSync(join(w.home, ".local", "bin", "ccn"))).toBe(join(w.appDir, "bin", "ccn"));
  expect(readFileSync(join(w.home, ".config", "ccn", "child.md"), "utf8")).toBe("new child");
  expect(readFileSync(join(w.home, ".config", "ccn", "child.md.old-20261106-1234"), "utf8")).toBe("old child");
  expect(w.svc.restarts).toEqual(["node"]);
});

test("uninstall removes the ccn link and an old cc link into the app, but keeps a foreign cc", async () => {
  const w = world();
  const bin = join(w.home, ".local", "bin");
  mkdirSync(bin, { recursive: true });
  symlinkSync(join(w.appDir, "bin", "ccn"), join(bin, "ccn"));
  symlinkSync(join(w.appDir, "bin", "cc"), join(bin, "cc"));
  saveConfig({ name: "vm", port: 4322, roots: [] }, join(w.configDir, "ccn.json"));
  expect(await main(["uninstall"], w.ctx)).toBe(0);
  expect(isLink(join(bin, "ccn"))).toBe(false);
  expect(isLink(join(bin, "cc"))).toBe(false);
  const v = world();
  const vbin = join(v.home, ".local", "bin");
  mkdirSync(vbin, { recursive: true });
  writeFileSync(join(vbin, "cc"), "someone else's cc");
  expect(await main(["uninstall"], v.ctx)).toBe(0);
  expect(readFileSync(join(vbin, "cc"), "utf8")).toBe("someone else's cc");
});

test("uninstall removes services and the cc directories", async () => {
  const w = world();
  mkdirSync(w.appDir, { recursive: true });
  saveConfig({ name: "vm", port: 4322, roots: [] }, join(w.configDir, "ccn.json"));
  expect(await main(["uninstall"], w.ctx)).toBe(0);
  expect(w.svc.uninstalls).toBe(1);
  expect(existsSync(w.configDir)).toBe(false);
  expect(existsSync(join(w.home, ".local", "share", "cc"))).toBe(false);
});

test("setup reads the CF API token from stdin with --cf-token-stdin and never prompts", async () => {
  const w = world({ tty: async () => { throw new Error("tty must not be used"); } });
  const ctx = { ...w.ctx, stdin: async () => "CF-FROM-STDIN\n" };
  expect(await main(["setup", "--hosts", "*.cc.fybe.jp", ...SETUP, "--cf-token-stdin"], ctx)).toBe(0);
  expect(loadConfig(join(w.configDir, "ccn.json")).cfApiToken).toBe("CF-FROM-STDIN");
  expect(w.lines.join("\n")).not.toContain("CF-FROM-STDIN");
});

test("node token re-issues the join token for an existing node", async () => {
  const w = world();
  saveConfig({ name: "pro", port: 4323, roots: [w.home], domain: "cc.fybe.jp", zone: "fybe.jp", teamDomain: "t", aud: "a", accountId: "acc", entry: "https://vm.cc.fybe.jp", serviceToken: { clientId: "cid", clientSecret: "csec" }, cfApiToken: "CF" }, join(w.configDir, "ccn.json"));
  expect(await main(["node", "token", "vm", "--port", "4322"], w.ctx)).toBe(0);
  expect(w.calls.map((c) => c.slice(0, 3).join(" "))).toEqual(["tunnels list", "tunnels token get"]);
  expect(w.clip.length).toBe(1);
  expect(w.lines.join("\n")).not.toContain(w.clip[0]!);
});

test("node token --to writes the join token to a 0600 file instead of the clipboard", async () => {
  const w = world();
  saveConfig({ name: "pro", port: 4323, roots: [w.home], domain: "cc.fybe.jp", zone: "fybe.jp", teamDomain: "t", aud: "a", accountId: "acc", entry: "https://vm.cc.fybe.jp", serviceToken: { clientId: "cid", clientSecret: "csec" }, cfApiToken: "CF" }, join(w.configDir, "ccn.json"));
  const out = join(w.home, "join.token");
  expect(await main(["node", "token", "vm", "--to", out], w.ctx)).toBe(0);
  expect(statSync(out).mode & 0o777).toBe(0o600);
  expect(decodeJoinToken(readFileSync(out, "utf8")).name).toBe("vm");
  expect(w.clip.length).toBe(0);
  expect(w.lines.join("\n")).not.toContain(readFileSync(out, "utf8").trim());
});

test("doctor reports ng when the external API returns 530", async () => {
  const w = world();
  saveConfig({ name: "pro", port: 4323, roots: [w.home], domain: "cc.fybe.jp", serviceToken: { clientId: "cid", clientSecret: "csec" } }, join(w.configDir, "ccn.json"));
  const ctx = { ...w.ctx, fetchFn: (async (i: RequestInfo | URL) => {
    const u = new URL(new Request(i).url);
    if (u.hostname === "ccn-pro.fybe.jp") return new Response("error code: 530", { status: 530 });
    // read はストリームが閉じても result まで繋ぎ直すので、偽のノードは result を返す
    return new Response(u.pathname.endsWith("/events") ? "id: 1\nevent: result\ndata: {}\n\n" : JSON.stringify({ name: "pro", id: "s1", pending: [], state: "idle", capabilities: { events: true } }), { headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch };
  expect(await main(["doctor"], ctx)).toBe(1);
  expect(w.lines.some((l) => l.startsWith("ng 外からの API") && l.includes("530"))).toBe(true);
});

// 改名前（cc）の機械を temp の home に作る。旧の常駐の plist、設定、アプリ、スキルのリンク、~/.config/session-inbox、~/.local/bin のリンク
function legacyMachine(home: string) {
  const cfgDir = join(home, ".config", "cc");
  mkdirSync(cfgDir, { recursive: true, mode: 0o700 });
  saveConfig({ name: "vm", port: 4322, roots: [home], domain: "cc.fybe.jp", entry: "https://cc.fybe.jp", serviceToken: { clientId: "cid", clientSecret: "csec" } }, join(cfgDir, "cc.json"));
  writeFileSync(join(cfgDir, "tunnel.token"), "TUNNEL", { mode: 0o600 });
  writeFileSync(join(cfgDir, "sends.json"), '{"vm/x":3}\n');
  const la = join(home, "Library", "LaunchAgents");
  mkdirSync(la, { recursive: true });
  for (const k of ["node", "tunnel"]) writeFileSync(join(la, `jp.fybe.cc.${k}.plist`), "");
  const oldApp = join(home, ".local", "share", "cc", "app");
  mkdirSync(join(oldApp, "skills", "session-inbox"), { recursive: true });
  mkdirSync(join(oldApp, "bin"), { recursive: true });
  writeFileSync(join(oldApp, "bin", "ccn"), ""); writeFileSync(join(oldApp, "bin", "cc"), "");
  mkdirSync(join(home, ".local", "share", "cc", "log"), { recursive: true });
  mkdirSync(join(home, ".agents", "skills"), { recursive: true });
  symlinkSync(join(oldApp, "skills", "session-inbox"), join(home, ".agents", "skills", "session-inbox"));
  mkdirSync(join(home, ".claude", "skills"), { recursive: true });
  symlinkSync("../../.agents/skills/session-inbox", join(home, ".claude", "skills", "session-inbox"));
  mkdirSync(join(home, ".config", "session-inbox"), { recursive: true });
  writeFileSync(join(home, ".config", "session-inbox", "child.md"), "old child");
  mkdirSync(join(home, ".local", "bin"), { recursive: true });
  symlinkSync(join(oldApp, "bin", "ccn"), join(home, ".local", "bin", "ccn"));
  symlinkSync(join(oldApp, "bin", "cc"), join(home, ".local", "bin", "cc"));
}
// 旧の常駐を外すと plist も消える偽物。順番を order に残す
function legacyWorld(order: string[]) {
  const w0: { home?: string } = {};
  const w = world({
    run: macRun([]),
    services: () => ({ install: async () => { order.push("install"); }, uninstall: async () => { order.push("uninstall"); }, restart: async (k) => { order.push(`restart ${k}`); }, status: async () => ({ node: "running", tunnel: "running" }) }),
    legacyServices: () => ({
      install: async () => {}, restart: async () => {}, status: async () => ({ node: "stopped", tunnel: "stopped" }),
      uninstall: async () => {
        // 外す時点で、ファイルの移動は済んでいる（外してから入れるまでの間を短くする）
        order.push(`legacy-uninstall config-moved=${existsSync(join(w0.home!, ".config", "ccn", "ccn.json"))}`);
        for (const k of ["node", "tunnel"]) rmSync(join(w0.home!, "Library", "LaunchAgents", `jp.fybe.cc.${k}.plist`), { force: true });
      },
    }),
  });
  w0.home = w.home;
  legacyMachine(w.home);
  return w;
}

test("update on a legacy machine moves config, app, skill and child.md, then swaps the services", async () => {
  const order: string[] = [];
  const w = legacyWorld(order);
  const ctx = { ...w.ctx, fetchFn: (async () => { throw new Error("must not fetch"); }) as unknown as typeof fetch };
  expect(await main(["update", "--from", bundleSrc("new child")], ctx)).toBe(0);
  // 設定は ~/.config/ccn へ。cc.json は ccn.json に、秘密のファイルは 0600 のまま
  const cfgDir = join(w.home, ".config", "ccn");
  expect(loadConfig(join(cfgDir, "ccn.json")).serviceToken).toEqual({ clientId: "cid", clientSecret: "csec" });
  expect(statSync(join(cfgDir, "ccn.json")).mode & 0o777).toBe(0o600);
  expect(statSync(join(cfgDir, "tunnel.token")).mode & 0o777).toBe(0o600);
  expect(readFileSync(join(cfgDir, "sends.json"), "utf8")).toContain("vm/x");
  expect(existsSync(join(w.home, ".config", "cc"))).toBe(false);
  // 常駐は旧を外してから新を入れる。外すのはファイルを移した後
  expect(order).toEqual(["legacy-uninstall config-moved=true", "install"]);
  // アプリは新の置き場、旧の置き場は消える
  expect(readFileSync(join(w.appDir, "package.json"), "utf8")).toBe('{"version":"9.9.9"}');
  expect(existsSync(join(w.home, ".local", "share", "cc"))).toBe(false);
  // スキルは ccn にリンクし、旧の session-inbox のリンクは消える
  expect(readlinkSync(join(w.home, ".agents", "skills", "ccn"))).toBe(join(w.appDir, "skills", "ccn"));
  expect(readlinkSync(join(w.home, ".claude", "skills", "ccn"))).toBe("../../.agents/skills/ccn");
  expect(isLink(join(w.home, ".agents", "skills", "session-inbox"))).toBe(false);
  expect(isLink(join(w.home, ".claude", "skills", "session-inbox"))).toBe(false);
  // child.md は ~/.config/ccn/child.md。~/.config/session-inbox は退避して消える
  expect(readFileSync(join(cfgDir, "child.md"), "utf8")).toBe("new child");
  expect(readFileSync(join(cfgDir, "legacy-session-inbox-20261106", "child.md"), "utf8")).toBe("old child");
  expect(existsSync(join(w.home, ".config", "session-inbox"))).toBe(false);
  // ~/.local/bin の ccn は新のアプリへ、旧のアプリを指す cc は消える
  expect(readlinkSync(join(w.home, ".local", "bin", "ccn"))).toBe(join(w.appDir, "bin", "ccn"));
  expect(isLink(join(w.home, ".local", "bin", "cc"))).toBe(false);
  // 2回目は旧の常駐に触らない
  order.length = 0;
  expect(await main(["update", "--from", bundleSrc("new child")], ctx)).toBe(0);
  expect(order.some((o) => o.startsWith("legacy-uninstall"))).toBe(false);
  expect(existsSync(join(cfgDir, "legacy-session-inbox-20261106-2"))).toBe(false);
});

test("install on a legacy machine drops the old services before installing the new ones", async () => {
  const order: string[] = [];
  const w = legacyWorld(order);
  expect(await main(["install"], w.ctx)).toBe(0);
  expect(order.slice(0, 2)).toEqual(["legacy-uninstall config-moved=true", "install"]);
  const cfgDir = join(w.home, ".config", "ccn");
  expect(loadConfig(join(cfgDir, "ccn.json")).aud).toBe("aud1");      // 参加トークンの設定で上書き
  expect(readFileSync(join(cfgDir, "tunnel.token"), "utf8")).toBe("TUNNEL-TOKEN");
  expect(readFileSync(join(cfgDir, "sends.json"), "utf8")).toContain("vm/x"); // 控えは引き継ぐ
  expect(existsSync(join(w.home, ".config", "cc"))).toBe(false);
  expect(existsSync(join(w.home, ".local", "share", "cc"))).toBe(false);
  expect(existsSync(join(w.home, ".config", "session-inbox"))).toBe(false);
});

test("a new node reads the legacy config until it is moved", async () => {
  const order: string[] = [];
  const w = legacyWorld(order);
  // 旧の ccn update が新しいコードを旧の置き場に入れた直後。新の設定はまだ無い
  expect(existsSync(join(w.configDir, "ccn.json"))).toBe(false);
  await main(["doctor"], w.ctx);
  expect(w.lines.some((l) => l.includes("改名前（cc）の常駐か置き場が残っている"))).toBe(true);
  // 手元の API は旧の設定のポート（4322）に向く。既定値で立ち上がっていない
  expect(w.lines.some((l) => l.includes("http://127.0.0.1:4322/api/host"))).toBe(true);
});

test("update falls back to the legacy bundle path when the entry has not been updated yet, and --entry rewrites the entry", async () => {
  const w = world();
  saveConfig({ name: "vm", port: 4322, roots: [w.home], domain: "cc.fybe.jp", entry: "https://cc.fybe.jp" }, join(w.configDir, "ccn.json"));
  const src = mkdtempSync(join(tmpdir(), "cc-tar-"));
  writeFileSync(join(src, "package.json"), '{"version":"9.9.9"}');
  const tgz = await new Response(Bun.spawn(["tar", "czf", "-", "-C", src, "package.json"], { stdout: "pipe" }).stdout).arrayBuffer();
  const fetched: string[] = [];
  const ctx = { ...w.ctx, fetchFn: (async (i: RequestInfo | URL) => {
    const u = new Request(i).url;
    fetched.push(u);
    return u.endsWith("/install/ccn.tar.gz") ? new Response("not found", { status: 404 }) : new Response(tgz, { headers: { "content-type": "application/gzip" } });
  }) as typeof fetch };
  expect(await main(["update"], ctx)).toBe(0);
  expect(fetched).toEqual(["https://cc.fybe.jp/install/ccn.tar.gz", "https://cc.fybe.jp/install/cc.tar.gz"]);
  fetched.length = 0;
  expect(await main(["update", "--entry", "https://ccn.fybe.jp"], ctx)).toBe(0);
  expect(fetched[0]).toBe("https://ccn.fybe.jp/install/ccn.tar.gz");
  const cfg = loadConfig(join(w.configDir, "ccn.json"));
  expect([cfg.entry, cfg.domain]).toEqual(["https://ccn.fybe.jp", "ccn.fybe.jp"]);
  expect(await main(["update", "--entry", "ccn.fybe.jp; rm -rf ~"], ctx)).toBe(1);
});

test("uninstall keeps the legacy-session-inbox backup", async () => {
  const w = world();
  saveConfig({ name: "vm", port: 4322, roots: [w.home] }, join(w.configDir, "ccn.json"));
  mkdirSync(join(w.configDir, "legacy-session-inbox-20261111"), { recursive: true });
  writeFileSync(join(w.configDir, "legacy-cc.json"), "{}");
  expect(await main(["uninstall"], w.ctx)).toBe(0);
  expect(existsSync(join(w.configDir, "legacy-cc.json"))).toBe(false);
  expect(existsSync(join(w.configDir, "ccn.json"))).toBe(false);
  expect(existsSync(join(w.configDir, "legacy-session-inbox-20261111"))).toBe(true);
});

test("node migrate adds the ccn- hostname to a legacy tunnel and renames it with --rename", async () => {
  const calls: string[][] = [];
  const w = world({ cf: async (args) => {
    calls.push(args);
    const out = (result: unknown) => ({ stdout: JSON.stringify({ result }), code: 0 });
    const key = args.slice(0, 3).join(" ");
    if (key === "tunnels list") return out([{ id: "tun-1", name: "cc-vm" }]);
    if (key === "tunnels config get") return out({ config: { ingress: [{ hostname: "cc-vm.fybe.jp", service: "http://127.0.0.1:4322" }] } });
    if (key === "dns records list") return out([]);
    if (key === "tunnels edit tun-1") return { stdout: "", code: 0 };
    return out({});
  } });
  saveConfig({ name: "pro", port: 4323, roots: [w.home], domain: "cc.fybe.jp", zone: "fybe.jp", teamDomain: "t", aud: "a", accountId: "acc", serviceToken: { clientId: "cid", clientSecret: "csec" }, cfApiToken: "CF" }, join(w.configDir, "ccn.json"));
  expect(await main(["node", "migrate", "vm"], w.ctx)).toBe(0);
  expect(calls.some((c) => c[1] === "edit")).toBe(false);
  expect(w.lines.some((l) => l.startsWith("ccn-vm.fybe.jp を ingress に足した"))).toBe(true);
  expect(await main(["node", "migrate", "vm", "--rename"], w.ctx)).toBe(0);
  expect(calls.at(-1)).toEqual(["tunnels", "edit", "tun-1", "--name", "ccn-vm"]);
});

test("a config file given by CCN_CONFIG is the one doctor and serve read", async () => {
  const w0 = world();
  const file = join(w0.home, "other.json");
  saveConfig({ name: "other", port: 4999, roots: [w0.home] }, file);
  saveConfig({ name: "main", port: 4323, roots: [w0.home] }, join(w0.configDir, "ccn.json"));
  const w = world({ configFile: file });
  await main(["doctor"], w.ctx);
  expect(w.lines.some((l) => l.includes("http://127.0.0.1:4999/api/host"))).toBe(true);
});

test("update installs the services again when the node is not running (a previous update stopped half way)", async () => {
  const w = world({ services: () => ({ install: async () => { calls.push("install"); }, uninstall: async () => {}, restart: async (k) => { calls.push(`restart ${k}`); }, status: async () => ({ node: "stopped", tunnel: "running" }) }) });
  const calls: string[] = [];
  saveConfig({ name: "vm", port: 4322, roots: [w.home] }, join(w.configDir, "ccn.json"));
  const ctx = { ...w.ctx, fetchFn: (async () => { throw new Error("must not fetch"); }) as unknown as typeof fetch };
  expect(await main(["update", "--from", bundleSrc()], ctx)).toBe(0);
  expect(calls).toEqual(["install"]);
});

test("update moves tunnel.token even when ccn setup already wrote ccn.json, and keeps the old cc.json aside", async () => {
  const order: string[] = [];
  const w = legacyWorld(order);
  // 移行の前に新しいコードの ccn setup が新の置き場に書いた
  saveConfig({ name: "vm", port: 4322, roots: [w.home], aud: "from-setup" }, join(w.configDir, "ccn.json"));
  const ctx = { ...w.ctx, fetchFn: (async () => { throw new Error("must not fetch"); }) as unknown as typeof fetch };
  expect(await main(["update", "--from", bundleSrc()], ctx)).toBe(0);
  expect(loadConfig(join(w.configDir, "ccn.json")).aud).toBe("from-setup");
  expect(readFileSync(join(w.configDir, "tunnel.token"), "utf8")).toBe("TUNNEL");
  expect(readFileSync(join(w.configDir, "sends.json"), "utf8")).toContain("vm/x");
  expect(loadConfig(join(w.configDir, "legacy-cc.json")).serviceToken?.clientId).toBe("cid");
  expect(existsSync(join(w.home, ".config", "cc"))).toBe(false);
});

test("update --from writes the lobby and its CLAUDE.md from the installed template", async () => {
  const w = world({ run: macRun([]) });
  saveConfig({ name: "vm", port: 4322, roots: [w.home] }, join(w.configDir, "ccn.json"));
  const src = bundleSrc();
  mkdirSync(join(src, "src", "lobby"), { recursive: true });
  writeFileSync(join(src, "src", "lobby", "lobby-claude.md"), readFileSync(join(import.meta.dir, "..", "..", "src", "lobby", "lobby-claude.md"), "utf8"));
  const ctx = { ...w.ctx, fetchFn: (async () => { throw new Error("must not fetch"); }) as unknown as typeof fetch };
  expect(await main(["update", "--from", src], ctx)).toBe(0);
  const md = readFileSync(join(w.home, ".local", "share", "ccn", "lobby", "CLAUDE.md"), "utf8");
  expect(md).toContain("受け口（Claude Code Nodes、vm）");
  const settings = JSON.parse(readFileSync(join(w.home, ".local", "share", "ccn", "lobby", ".claude", "settings.json"), "utf8"));
  expect(settings.permissions.allow).toContain("Bash(ccn places *)");
  expect((settings.permissions.allow as string[]).some((r) => r.startsWith("Read"))).toBe(false);
  expect(w.lines.join("\n")).toContain("CLAUDE.md と .claude/settings.json を書いた");
});

test("install --from writes the lobby's CLAUDE.md and .claude/settings.json and keeps settings.local.json", async () => {
  const w = world();
  const src = mkdtempSync(join(tmpdir(), "cc-src-"));
  mkdirSync(join(src, "skills", "ccn"), { recursive: true });
  writeFileSync(join(src, "skills", "ccn", "child.md"), "child");
  writeFileSync(join(src, "package.json"), '{"version":"0.0.1"}');
  mkdirSync(join(src, "bin")); writeFileSync(join(src, "bin", "ccn"), "#!/bin/sh\n");
  mkdirSync(join(src, "src", "lobby"), { recursive: true });
  writeFileSync(join(src, "src", "lobby", "lobby-claude.md"), readFileSync(join(import.meta.dir, "..", "..", "src", "lobby", "lobby-claude.md"), "utf8"));
  const lobby = join(w.home, ".local", "share", "ccn", "lobby");
  mkdirSync(join(lobby, ".claude"), { recursive: true });
  writeFileSync(join(lobby, ".claude", "settings.local.json"), "{}\n");
  expect(await main(["install", "--from", src], w.ctx)).toBe(0);
  expect(w.lines.join("\n")).toContain("CLAUDE.md と .claude/settings.json を書いた");
  expect(readFileSync(join(lobby, "CLAUDE.md"), "utf8")).toContain("受け口（Claude Code Nodes、");
  expect(JSON.parse(readFileSync(join(lobby, ".claude", "settings.json"), "utf8")).permissions.allow).toContain("Bash(ccn new *)");
  expect(readFileSync(join(lobby, ".claude", "settings.local.json"), "utf8")).toBe("{}\n");
});

test("setup keeps a configured lobby", async () => {
  const w = world();
  saveConfig({ name: "konaito-pro", port: 4323, roots: [w.home], lobby: join(w.home, "lobby") }, join(w.configDir, "ccn.json"));
  expect(await main(["setup", "--hosts", "*.cc.fybe.jp", ...SETUP], w.ctx)).toBe(0);
  expect(loadConfig(join(w.configDir, "ccn.json")).lobby).toBe(join(w.home, "lobby"));
});
