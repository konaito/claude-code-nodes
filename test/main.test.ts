import { test, expect } from "bun:test";
import { mkdtempSync, readFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildDeps, start } from "../src/main";
import { AccessIdentity } from "../src/identity/access";
import { HeaderIdentity } from "../src/identity/identity";
import { CloudflareRegistry } from "../src/registry/cloudflare";
import { StaticRegistry } from "../src/registry/registry";

// 組み立て。Access の設定があるノードは JWT を検証し、無いノードはヘッダだけを見る
test("buildDeps uses AccessIdentity and CloudflareRegistry when the config has them", () => {
  const d = buildDeps({ name: "vm", port: 4322, roots: ["/"], domain: "cc.fybe.jp", teamDomain: "t.cloudflareaccess.com", aud: "a", accountId: "acc", cfApiToken: "tok", serviceToken: { clientId: "c", clientSecret: "s" } });
  expect(d.identity).toBeInstanceOf(AccessIdentity);
  expect(d.registry).toBeInstanceOf(CloudflareRegistry);
});

test("buildDeps falls back to HeaderIdentity and StaticRegistry without them", () => {
  const d = buildDeps({ name: "dev", port: 4399, roots: ["/"] });
  expect(d.identity).toBeInstanceOf(HeaderIdentity);
  expect(d.registry).toBeInstanceOf(StaticRegistry);
});

test("start writes the lobby's CLAUDE.md and .claude/settings.json before serving", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "ccn-start-")));
  const lobby = join(root, "lobby");
  const log = console.log; console.log = () => {};
  const server = start({ name: "dev", port: 0, roots: [root], lobby });
  console.log = log;
  try {
    expect(readFileSync(join(lobby, "CLAUDE.md"), "utf8")).toContain("受け口（Claude Code Nodes、dev）");
    const allow = JSON.parse(readFileSync(join(lobby, ".claude", "settings.json"), "utf8")).permissions.allow as string[];
    expect(allow).toContain("Bash(ccn places *)");
    expect(allow.some((r) => r.startsWith("Read"))).toBe(false);
  } finally { server.stop(true); }
});
