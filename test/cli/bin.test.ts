import { test, expect } from "bun:test";
import { mkdtempSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// ~/.local/bin/ccn のような symlink から呼ばれても、実体の隣の src/cli/cc.ts を動かす
test("bin/ccn works through a symlink", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cc-bin-"));
  const link = join(dir, "ccn");
  symlinkSync(join(import.meta.dir, "..", "..", "bin", "ccn"), link);
  const p = Bun.spawn([link, "--help"], { stdout: "pipe", stderr: "pipe", env: { ...process.env, CC_CONFIG: "/nonexistent/cc.json" } });
  const out = await new Response(p.stdout).text();
  const err = await new Response(p.stderr).text();
  expect(await p.exited).toBe(1);
  expect(out).toContain("ccn peers");
  expect(err).not.toContain("Module not found");
});
