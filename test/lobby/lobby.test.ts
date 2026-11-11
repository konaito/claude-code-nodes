import { test, expect } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, realpathSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureLobby, lobbySettings, lobbySettingsFor, prepareLobby } from "../../src/lobby/lobby";
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

test("the lobby template keeps the strings the page, MCP and docs depend on", () => {
  const home = mkdtempSync(join(tmpdir(), "ccn-lobby-home-"));
  const dir = join(home, "lobby");
  ensureLobby({ dir, appRoot, nodeName: "vm", roots: [home] });
  const md = readFileSync(join(dir, "CLAUDE.md"), "utf8");
  expect(md).toContain("子: <peer>/<sessionId>"); // 画面のリンクと MCP の説明がこの形を読む
  expect(md).toContain("--mode <自分のモード>");   // 子の権限を受け口のモードまでにする
  expect(md).toContain("--as lobby");
  expect(md).toContain(`${CLI_NAME} allow`);
  expect(md).toContain(`${CLI_NAME} deny`);
  expect(md).toContain("AskUserQuestion");
});

const readSettings = (dir: string) => JSON.parse(readFileSync(join(dir, ".claude", "settings.json"), "utf8")) as { permissions: { allow: string[]; deny?: string[] } };

test("ensureLobby writes .claude/settings.json with the ccn subcommands and absolute Read rules for each root", () => {
  const home = mkdtempSync(join(tmpdir(), "ccn-lobby-home-"));
  const dir = join(home, "lobby");
  ensureLobby({ dir, appRoot, nodeName: "vm", roots: [home, "/srv/work"] });
  const s = readSettings(dir);
  expect(s.permissions.allow).toContain(`Bash(${CLI_NAME} new *)`);
  expect(s.permissions.allow).toContain(`Bash(${CLI_NAME} allow *)`);
  expect(s.permissions.allow).toContain(`Read(/${home}/**)`); // // で始まる絶対パス
  expect(s.permissions.allow).toContain("Read(//srv/work/**)");
  expect(Object.keys(s)).toEqual(["permissions"]);              // hooks、env、additionalDirectories などは置かない
  expect(Object.keys(s.permissions)).toEqual(["allow"]);
});

test("the lobby's allow list has no write, delete, network, git or broad rules", () => {
  const allow = lobbySettings(["/home/u"]).permissions.allow;
  for (const rule of allow) {
    // 許すのは ccn の決まった下位命令と、roots の下の Read だけ
    expect(rule).toMatch(new RegExp(`^(Bash\\(${CLI_NAME} (peers|ls|show|new|run|read|allow|deny|stop) \\*\\)|Read\\(//.+/\\*\\*\\))$`));
  }
  const banned = ["Edit", "Write", "WebFetch", "WebSearch", "Bash(*)", "Bash(git", "Bash(rm", "Bash(curl", "Bash(wget", `Bash(${CLI_NAME} *)`, `Bash(${CLI_NAME}:*)`, `${CLI_NAME} update`, `${CLI_NAME} uninstall`, `${CLI_NAME} send`, `${CLI_NAME} node`, `${CLI_NAME} setup`, `${CLI_NAME} serve`];
  for (const b of banned) expect(allow.some((r) => r === b || r.startsWith(b))).toBe(false);
  expect(allow).not.toContain("Bash");
  expect(allow).not.toContain("Read");
});

test("ensureLobby rewrites a changed settings.json and never touches settings.local.json", () => {
  const home = mkdtempSync(join(tmpdir(), "ccn-lobby-home-"));
  const dir = join(home, "lobby");
  ensureLobby({ dir, appRoot, nodeName: "vm", roots: [home] });
  writeFileSync(join(dir, ".claude", "settings.local.json"), '{"permissions":{"allow":["Bash(make test)"]}}\n');
  expect(ensureLobby({ dir, appRoot, nodeName: "vm", roots: [home] }).written).toBe(false);
  writeFileSync(join(dir, ".claude", "settings.json"), '{"permissions":{"allow":["Bash"]}}\n');
  expect(ensureLobby({ dir, appRoot, nodeName: "vm", roots: [home] }).written).toBe(true);
  expect(readSettings(dir).permissions.allow).not.toContain("Bash");
  expect(readFileSync(join(dir, ".claude", "settings.local.json"), "utf8")).toBe('{"permissions":{"allow":["Bash(make test)"]}}\n');
});

test("lobbySettingsFor returns the settings path only for the lobby itself, not for children or other places", async () => {
  const home = realpathSync(mkdtempSync(join(tmpdir(), "ccn-lobby-home-")));
  const dir = join(home, "lobby");
  ensureLobby({ dir, appRoot, nodeName: "vm", roots: [home] });
  const child = join(home, "proj");
  mkdirSync(child);
  expect(await lobbySettingsFor(dir, dir)).toBe(join(dir, ".claude", "settings.json"));
  expect(await lobbySettingsFor(child, dir)).toBeUndefined();
  expect(await lobbySettingsFor(join(dir, "sub"), dir)).toBeUndefined();
  // 設定の lobby が symlink でも、API が渡す realpath の cwd と合う
  const link = join(home, "lobby-link");
  symlinkSync(dir, link);
  expect(await lobbySettingsFor(dir, link)).toBe(join(dir, ".claude", "settings.json"));
  // まだ書かれていない受け口では渡さない（無いファイルを --settings に渡さない）
  const bare = join(home, "bare");
  mkdirSync(bare);
  expect(await lobbySettingsFor(bare, bare)).toBeUndefined();
});

test("the lobby template tells the lobby to avoid the command shapes that always ask", () => {
  const home = mkdtempSync(join(tmpdir(), "ccn-lobby-home-"));
  const dir = join(home, "lobby");
  ensureLobby({ dir, appRoot, nodeName: "vm", roots: [home] });
  const md = readFileSync(join(dir, "CLAUDE.md"), "utf8");
  expect(md).toContain("settings.local.json");
  expect(md).toContain(`\`${join(home, "Documents")}\``); // ~ を使わずに絶対パスで書く
  expect(md).toContain(".git/config");
  expect(md).not.toContain("show $CLAUDE_CODE_SESSION_ID");
  expect(md).not.toContain("~/Documents");
});
