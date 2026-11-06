import { test, expect } from "bun:test";
import { homedir, hostname } from "node:os";
import { mkdtempSync, writeFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, saveConfig, entryOf, nodeHost, APP_VERSION } from "../src/config";

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
  const cfg = { name: "vm", port: 4322, roots: ["/x"], domain: "cc.fybe.jp", teamDomain: "t.cloudflareaccess.com", aud: "a1", accountId: "acc", zone: "fybe.jp", entry: "https://vm.cc.fybe.jp", serviceToken: { clientId: "id", clientSecret: "sec" }, cfApiToken: "tok" };
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

// ノードのホスト名は1階層（cc-<name>.<zone>）。無料の証明書（*.fybe.jp）で覆える
test("nodeHost is cc-<name>.<zone>, derived from domain when zone is missing", () => {
  expect(nodeHost("vm", { zone: "fybe.jp" })).toBe("cc-vm.fybe.jp");
  expect(nodeHost("konaito-pro", { domain: "cc.fybe.jp" })).toBe("cc-konaito-pro.fybe.jp");
  expect(() => nodeHost("vm", {})).toThrow();
});
