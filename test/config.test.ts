import { test, expect } from "bun:test";
import { homedir, hostname } from "node:os";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/config";

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
