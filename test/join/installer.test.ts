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
