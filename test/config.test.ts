import { test, expect } from "bun:test";
import { homedir, hostname } from "node:os";
import { mkdtempSync, writeFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, saveConfig, entryOf, nodeHost, resolveConfigPath, lobbyOf, APP_VERSION } from "../src/config";

test("loadConfig falls back to hostname, 4322 and $HOME", () => {
  const c = loadConfig("/nonexistent/cc/cc.json");
  expect(c.port).toBe(4322);
  expect(c.roots).toEqual([homedir()]);
  expect(c.name).toBe(hostname().replace(/\.local$/, ""));
});

test("loadConfig reads name, port, roots from cc.json", () => {
  const p = join(mkdtempSync(join(tmpdir(), "cc-conf-")), "cc.json");
  writeFileSync(p, JSON.stringify({ name: "vm", port: 4400, roots: ["/x"] }));
  expect(loadConfig(p)).toEqual({ name: "vm", port: 4400, roots: ["/x"] });
});

test("saveConfig writes 0600 and loadConfig reads it back", () => {
  const p = join(mkdtempSync(join(tmpdir(), "cc-conf-")), "sub", "cc.json");
  const cfg = { name: "vm", port: 4322, roots: ["/x"], domain: "cc.fybe.jp", teamDomain: "t.cloudflareaccess.com", aud: "a1", accountId: "acc", zone: "fybe.jp", entry: "https://vm.cc.fybe.jp", serviceToken: { clientId: "id", clientSecret: "sec" }, cfApiToken: "tok", lobby: "/x/lobby" };
  saveConfig(cfg, p);
  expect(statSync(p).mode & 0o777).toBe(0o600);
  expect(loadConfig(p)).toEqual(cfg);
});

test("entryOf falls back to https://<domain>", () => {
  expect(entryOf({ name: "vm", port: 4322, roots: [], domain: "cc.fybe.jp" })).toBe("https://cc.fybe.jp");
  expect(entryOf({ name: "vm", port: 4322, roots: [], domain: "cc.fybe.jp", entry: "https://vm.cc.fybe.jp" })).toBe("https://vm.cc.fybe.jp");
  expect(entryOf({ name: "vm", port: 4322, roots: [] })).toBeUndefined();
  expect(APP_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
});

// ノードのホスト名は1階層（ccn-<name>.<zone>）。無料の証明書（*.fybe.jp）で覆える
test("nodeHost is ccn-<name>.<zone>, derived from domain when zone is missing", () => {
  expect(nodeHost("vm", { zone: "fybe.jp" })).toBe("ccn-vm.fybe.jp");
  expect(nodeHost("konaito-pro", { domain: "cc.fybe.jp" })).toBe("ccn-konaito-pro.fybe.jp");
  expect(() => nodeHost("vm", {})).toThrow();
});

test("resolveConfigPath reads the legacy ~/.config/cc/cc.json until the new one exists", () => {
  const home = mkdtempSync(join(tmpdir(), "ccn-home-"));
  expect(resolveConfigPath(home)).toBe(join(home, ".config", "ccn", "ccn.json"));
  saveConfig({ name: "old", port: 4399, roots: [home] }, join(home, ".config", "cc", "cc.json"));
  expect(resolveConfigPath(home)).toBe(join(home, ".config", "cc", "cc.json"));
  expect(loadConfig(resolveConfigPath(home)).port).toBe(4399);
  saveConfig({ name: "new", port: 4400, roots: [home] }, join(home, ".config", "ccn", "ccn.json"));
  expect(resolveConfigPath(home)).toBe(join(home, ".config", "ccn", "ccn.json"));
});

test("lobbyOf is the configured lobby, else <home>/.local/share/ccn/lobby", () => {
  expect(lobbyOf({ name: "vm", port: 1, roots: ["/x"], lobby: "/x/in" }, "/home/u")).toBe("/x/in");
  expect(lobbyOf({ name: "vm", port: 1, roots: ["/x"] }, "/home/u")).toBe("/home/u/.local/share/ccn/lobby");
});
