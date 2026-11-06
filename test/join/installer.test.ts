import { test, expect } from "bun:test";
import { installerScript } from "../../src/join/installer";
import { BUNDLE_PATHS } from "../../src/join/bundle";

test("installer reads the token from /dev/tty or stdin and never from argv", () => {
  const s = installerScript({ entry: "https://vm.cc.fybe.jp", cliName: "cc" });
  expect(s.startsWith("#!/bin/sh\n")).toBe(true);
  expect(s).toContain("/dev/tty");
  expect(s).toContain("read -r");
  expect(s).not.toContain("$1");
  expect(s).toContain("https://vm.cc.fybe.jp/install/cc.tar.gz");
  expect(s).toContain("bun run src/cli/cc.ts install");
  expect(s).not.toMatch(/--token/);
});

test("bundle paths are the source and nothing else", () => {
  expect(BUNDLE_PATHS).toEqual(["src", "skills", "bin", "package.json", "bun.lock", "tsconfig.json", "README.md"]);
});

// pbpaste のように末尾に改行が無い入力でも、read が EOF で止まらずにトークンを受け取る
test("installer token read survives input without a trailing newline", async () => {
  const s = installerScript({ entry: "https://vm.cc.fybe.jp", cliName: "cc" });
  const begin = s.indexOf("# token-read-begin"); const end = s.indexOf("# token-read-end");
  expect(begin).toBeGreaterThan(0); expect(end).toBeGreaterThan(begin);
  const snippet = "set -eu\n" + s.slice(begin, end) + '\nprintf "%s" "$TOKEN"\n';
  const p = Bun.spawn(["sh", "-c", snippet], { stdin: new Blob(["abc123"]), stdout: "pipe", stderr: "pipe" });
  expect(await new Response(p.stdout).text()).toBe("abc123");
  expect(await p.exited).toBe(0);
});
