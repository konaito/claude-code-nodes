import { test, expect } from "bun:test";
import { launchdPlist, systemdUnit, serviceManager, type Paths } from "../../src/join/services";

const p: Paths = { home: "/Users/u", appDir: "/Users/u/.local/share/cc/app", configDir: "/Users/u/.config/cc", logDir: "/Users/u/.local/share/cc/log", bun: "/Users/u/.bun/bin/bun", cloudflared: "/opt/homebrew/bin/cloudflared", uid: 501 };

function fakeRun() {
  const calls: string[][] = [];
  const writes: Array<{ path: string; text: string }> = [];
  const run = async (cmd: string[]) => { calls.push(cmd); return { stdout: "", code: 0 }; };
  const write = (path: string, text: string) => { writes.push({ path, text }); };
  return { calls, writes, run, write };
}

test("launchd plist runs bun serve and cloudflared with the token file", () => {
  const node = launchdPlist("node", p);
  expect(node).toContain("<string>jp.fybe.ccn.node</string>");
  expect(node).toContain("<string>/Users/u/.bun/bin/bun</string>");
  expect(node).toContain("<string>/Users/u/.local/share/cc/app/src/cli/ccn.ts</string>");
  expect(node).toContain("<string>serve</string>");
  expect(node).toContain("<key>KeepAlive</key>");
  expect(node).toContain("/Users/u/.bun/bin:");
  expect(node).toContain("/Users/u/.local/share/cc/log/node.log");
  const tunnel = launchdPlist("tunnel", p);
  expect(tunnel).toContain("<string>jp.fybe.ccn.tunnel</string>");
  expect(tunnel).toContain("<string>/opt/homebrew/bin/cloudflared</string>");
  expect(tunnel).toContain("<string>--token-file</string>");
  expect(tunnel).toContain("<string>/Users/u/.config/cc/tunnel.token</string>");
});

test("systemd unit restarts always and installs to default.target", () => {
  const node = systemdUnit("node", p);
  expect(node).toContain("ExecStart=/Users/u/.bun/bin/bun run /Users/u/.local/share/cc/app/src/cli/ccn.ts serve");
  expect(node).toContain("Restart=always");
  expect(node).toContain("WantedBy=default.target");
  expect(node).toContain("Environment=PATH=/Users/u/.bun/bin:");
  const tunnel = systemdUnit("tunnel", p);
  expect(tunnel).toContain("ExecStart=/opt/homebrew/bin/cloudflared tunnel run --token-file /Users/u/.config/cc/tunnel.token");
});

test("darwin install writes two plists and bootstraps both", async () => {
  const f = fakeRun();
  await serviceManager("darwin", p, f.run, f.write).install();
  expect(f.writes.map((w) => w.path)).toEqual(["/Users/u/Library/LaunchAgents/jp.fybe.ccn.node.plist", "/Users/u/Library/LaunchAgents/jp.fybe.ccn.tunnel.plist"]);
  expect(f.calls).toEqual([
    ["launchctl", "bootout", "gui/501/jp.fybe.ccn.node"],
    ["launchctl", "bootstrap", "gui/501", "/Users/u/Library/LaunchAgents/jp.fybe.ccn.node.plist"],
    ["launchctl", "bootout", "gui/501/jp.fybe.ccn.tunnel"],
    ["launchctl", "bootstrap", "gui/501", "/Users/u/Library/LaunchAgents/jp.fybe.ccn.tunnel.plist"],
  ]);
});

test("linux install reloads then enables both", async () => {
  const f = fakeRun();
  await serviceManager("linux", p, f.run, f.write).install();
  expect(f.writes.map((w) => w.path)).toEqual(["/Users/u/.config/systemd/user/ccn-node.service", "/Users/u/.config/systemd/user/ccn-tunnel.service"]);
  expect(f.calls).toEqual([
    ["systemctl", "--user", "daemon-reload"],
    ["systemctl", "--user", "enable", "--now", "ccn-node"],
    ["systemctl", "--user", "enable", "--now", "ccn-tunnel"],
  ]);
});

test("restart and uninstall use the platform commands", async () => {
  const d = fakeRun();
  const m = serviceManager("darwin", p, d.run, d.write);
  await m.restart("node");
  expect(d.calls).toEqual([["launchctl", "kickstart", "-k", "gui/501/jp.fybe.ccn.node"]]);
  const l = fakeRun();
  await serviceManager("linux", p, l.run, l.write).uninstall();
  expect(l.calls).toEqual([["systemctl", "--user", "disable", "--now", "ccn-node"], ["systemctl", "--user", "disable", "--now", "ccn-tunnel"], ["systemctl", "--user", "daemon-reload"]]);
});
