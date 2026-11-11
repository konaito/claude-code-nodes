import { test, expect } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureLobby, prepareLobby } from "../../src/lobby/lobby";
import { CLI_NAME } from "../../src/names";

const appRoot = join(import.meta.dir, "..", "..");

test("ensureLobby creates the directory and a CLAUDE.md filled with the node's name, roots and CLI", () => {
  const home = mkdtempSync(join(tmpdir(), "ccn-lobby-home-"));
  const dir = join(home, ".local", "share", "ccn", "lobby");
  const r = ensureLobby({ dir, appRoot, nodeName: "vm", roots: [home] });
  expect(r.written).toBe(true);
  const md = readFileSync(join(dir, "CLAUDE.md"), "utf8");
  expect(md).toContain("vm");
  expect(md).toContain(`\`${home}\``);
  expect(md).toContain(`${CLI_NAME} new`);
  expect(md).toContain("CLAUDE.local.md");
  expect(md).not.toMatch(/\{\{[A-Z]+\}\}/);
});

test("ensureLobby rewrites a changed CLAUDE.md, leaves the same one alone and never touches CLAUDE.local.md", () => {
  const home = mkdtempSync(join(tmpdir(), "ccn-lobby-home-"));
  const dir = join(home, "lobby");
  ensureLobby({ dir, appRoot, nodeName: "vm", roots: [home] });
  writeFileSync(join(dir, "CLAUDE.local.md"), "mine\n");
  expect(ensureLobby({ dir, appRoot, nodeName: "vm", roots: [home] }).written).toBe(false);
  writeFileSync(join(dir, "CLAUDE.md"), "edited by hand\n");
  expect(ensureLobby({ dir, appRoot, nodeName: "vm", roots: [home] }).written).toBe(true);
  expect(readFileSync(join(dir, "CLAUDE.md"), "utf8")).not.toContain("edited by hand");
  expect(readFileSync(join(dir, "CLAUDE.local.md"), "utf8")).toBe("mine\n");
});

test("prepareLobby refuses a lobby outside the roots and reports a missing template", () => {
  const home = mkdtempSync(join(tmpdir(), "ccn-lobby-home-"));
  const out = prepareLobby({ dir: "/etc/ccn-lobby", appRoot, nodeName: "vm", roots: [home] });
  expect("error" in out && out.error).toContain("outside roots");
  expect(existsSync("/etc/ccn-lobby")).toBe(false);
  const noTpl = prepareLobby({ dir: join(home, "lobby"), appRoot: home, nodeName: "vm", roots: [home] });
  expect("error" in noTpl).toBe(true);
});
