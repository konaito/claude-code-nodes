// /skill.md の試験。認証なしで読め、入口の URL が差し込まれ、Agent Skills の形（name、description、500行未満）を守り、束に入る
import { test, expect } from "bun:test";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { createApp, type Deps } from "../../src/api/app";
import { AccessIdentity } from "../../src/identity/access";
import { SessionStore } from "../../src/sessions/store";
import { StaticRegistry } from "../../src/registry/registry";
import { Relay } from "../../src/relay/relay";
import { BUNDLE_PATHS } from "../../src/join/bundle";
import { PUBLIC_SKILL_NAME, SKILL_NAME } from "../../src/names";
import { skillMdPath } from "../../src/mcp/skill-md";

const appRoot = join(import.meta.dir, "..", "..");
function app() {
  const registry = new StaticRegistry([]);
  const deps = {
    nodeName: "vm", roots: ["/tmp"], lobby: "/tmp/lobby", store: new SessionStore(),
    identity: new AccessIdentity({ teamDomain: "t.cloudflareaccess.com", aud: "aud", fetchJwks: async () => ({ keys: [] }) }),
    history: {} as Deps["history"], startNode: async () => { throw new Error("no"); }, agents: async () => [], terminalFor: () => { throw new Error("no"); },
    host: async () => ({ claudeVersion: "x", load: [] }), registry, relay: new Relay({ registry, nodeName: "vm" }), appRoot,
  } satisfies Deps;
  return createApp(deps);
}
// Cloudflare を通った、JWT の無い要求（Bypass の先で届く形）
const viaCloudflare = (host: string, method = "GET") => new Request(`http://127.0.0.1:4322/skill.md`, { method, headers: { host, "cf-connecting-ip": "1.2.3.4" } });

test("/skill.md is readable without Access and carries the entry URL", async () => {
  const r = await app().fetch(viaCloudflare("ccn.example.com"));
  expect(r.status).toBe(200);
  expect(r.headers.get("content-type")).toBe("text/markdown; charset=utf-8");
  const body = await r.text();
  expect(body).toContain("https://ccn.example.com/mcp");
  expect(body).not.toContain("{{");
  // 手元から読むと http の 127.0.0.1
  const local = await (await app().fetch(new Request("http://127.0.0.1:4330/skill.md"))).text();
  expect(local).toContain("http://127.0.0.1:4330/mcp");
});

test("/skill.md refuses odd hosts and non-GET", async () => {
  expect((await app().fetch(viaCloudflare("evil.example/<script>"))).status).toBe(400);
  expect((await app().fetch(viaCloudflare("ccn.example.com", "POST"))).status).toBe(405);
  // 他の道は今までどおり Access が要る
  expect((await app().fetch(new Request("http://127.0.0.1:4322/api/host", { headers: { host: "ccn.example.com", "cf-connecting-ip": "1.2.3.4" } }))).status).toBe(401);
});

test("the source follows the Agent Skills format and ships in the bundle", () => {
  const path = skillMdPath(appRoot);
  expect(path).toBe(join(appRoot, "skills", PUBLIC_SKILL_NAME, "SKILL.md"));
  expect(PUBLIC_SKILL_NAME).not.toBe(SKILL_NAME); // 利用者の機械にリンクする CLI のスキルとは別
  expect(BUNDLE_PATHS).toContain("skills");
  const text = readFileSync(path, "utf8");
  const fm = text.match(/^---\n([\s\S]*?)\n---\n/);
  expect(fm).not.toBeNull();
  const name = fm![1]!.match(/^name: (.+)$/m)![1]!;
  const description = fm![1]!.match(/^description: (.+)$/m)![1]!;
  expect(name).toBe(PUBLIC_SKILL_NAME); // 親ディレクトリ名と同じ
  expect(name).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
  expect(name.length).toBeLessThanOrEqual(64);
  expect(description.length).toBeGreaterThan(0);
  expect(description.length).toBeLessThanOrEqual(1024);
  expect(text.split("\n").length).toBeLessThan(500);
  // 秘密、アカウント ID、メールアドレスを書かない
  expect(text).not.toMatch(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/);
  expect(text).not.toMatch(/\b[0-9a-f]{32}\b/);
  // MCP のツールは ccn:<ツール名> の完全修飾名で書き、MCP の口が載せているツールを全部挙げる
  for (const t of ["list_peers", "list_sessions", "get_session", "create_session", "send_message", "read_messages", "answer_permission", "interrupt_session", "stop_session"]) expect(text).toContain(`ccn:${t}`);
});
