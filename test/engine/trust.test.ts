import { describe, expect, test, beforeEach } from "bun:test";
import { mkdtemp, readFile, writeFile, stat, symlink, lstat, mkdir, utimes, realpath, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { claudeConfigFile, gitRootOf, trustDir } from "../../src/engine/trust";
import { bunRunner } from "../../src/engine/agents";

let dir: string;
let file: string;
const logs: string[] = [];
const log = (m: string) => logs.push(m);
const base = { numStartups: 3, oauthAccount: { emailAddress: "a@example.com" }, projects: { "/keep": { hasTrustDialogAccepted: true, allowedTools: ["Bash"] }, "/w": { lastCost: 1, hasTrustDialogAccepted: false } } };
const json = async () => JSON.parse(await readFile(file, "utf8"));

beforeEach(async () => {
  dir = await realpath(await mkdtemp(join(tmpdir(), "ccn-trust-")));
  file = join(dir, ".claude.json");
  await writeFile(file, JSON.stringify(base, null, 2), { mode: 0o644 });
  logs.length = 0;
});

describe("trustDir", () => {
  test("cwd と git のルートを true にし、他のキーと項目は残す", async () => {
    const r = await trustDir("/w/sub", { configFile: file, gitRoot: async () => "/w", log });
    expect(r).toEqual({ written: ["/w/sub", "/w"] });
    const j = await json();
    expect(j.numStartups).toBe(3);
    expect(j.oauthAccount).toEqual(base.oauthAccount);
    expect(j.projects["/keep"]).toEqual(base.projects["/keep"]);
    expect(j.projects["/w"]).toEqual({ lastCost: 1, hasTrustDialogAccepted: true });
    expect(j.projects["/w/sub"]).toEqual({ hasTrustDialogAccepted: true });
    // claude と同じ2文字の字下げ、元のモード、ロックと一時ファイルは残さない、控えは元の中身で 0600
    expect(await readFile(file, "utf8")).toBe(JSON.stringify(j, null, 2));
    expect((await stat(file)).mode & 0o777).toBe(0o644);
    expect((await readdir(dir)).sort()).toEqual([".claude.json", ".claude.json.ccn-trust.bak"]);
    expect(JSON.parse(await readFile(`${file}.ccn-trust.bak`, "utf8"))).toEqual(base);
    expect((await stat(`${file}.ccn-trust.bak`)).mode & 0o777).toBe(0o600);
  });

  test("git でなければ cwd だけ", async () => {
    expect(await trustDir("/plain", { configFile: file, gitRoot: async () => undefined, log })).toEqual({ written: ["/plain"] });
    expect(Object.keys((await json()).projects)).toEqual(["/keep", "/w", "/plain"]);
  });

  test("既に true なら書かない", async () => {
    const before = await stat(file);
    expect(await trustDir("/keep", { configFile: file, log })).toEqual({ already: ["/keep"] });
    expect((await stat(file)).mtimeMs).toBe(before.mtimeMs);
    expect(logs).toEqual([]);
  });

  for (const [name, content] of [["空", ""], ["空白だけ", "  \n"], ["JSON でない", "{ broken"], ["配列", "[]"], ["projects が配列", '{"projects": []}']] as const) {
    test(`読めないファイル（${name}）には書かず、起動は続ける`, async () => {
      await writeFile(file, content);
      const r = await trustDir("/x", { configFile: file, log });
      expect("skipped" in r).toBe(true);
      expect(await readFile(file, "utf8")).toBe(content);
      expect(logs.length).toBe(1);
    });
  }

  test("ファイルが無ければ作らない", async () => {
    const missing = join(dir, "nope", ".claude.json");
    expect(await trustDir("/x", { configFile: missing, log })).toEqual({ skipped: "config not found" });
    expect(await stat(missing).catch(() => null)).toBeNull();
  });

  test("symlink なら実体に書き、symlink は残す", async () => {
    const link = join(dir, "link.json");
    await symlink(file, link);
    await trustDir("/x", { configFile: link, log });
    expect((await lstat(link)).isSymbolicLink()).toBe(true);
    expect((await json()).projects["/x"]).toEqual({ hasTrustDialogAccepted: true });
  });

  test("claude のロックが新しいうちは待ち、空かなければ書かない", async () => {
    await mkdir(`${file}.lock`);
    const r = await trustDir("/x", { configFile: file, log, lockWaitMs: 150 });
    expect(r).toEqual({ skipped: "locked" });
    expect((await json()).projects["/x"]).toBeUndefined();
    expect((await stat(`${file}.lock`)).isDirectory()).toBe(true); // 人のロックは外さない
  });

  test("ロックが途中で空けば書く", async () => {
    await mkdir(`${file}.lock`);
    setTimeout(() => void import("node:fs/promises").then((f) => f.rmdir(`${file}.lock`)), 100);
    expect(await trustDir("/x", { configFile: file, log, lockWaitMs: 2000 })).toEqual({ written: ["/x"] });
  });

  test("古いロック（落ちた claude の残り）は外して書く", async () => {
    await mkdir(`${file}.lock`);
    const old = new Date(Date.now() - 60_000);
    await utimes(`${file}.lock`, old, old);
    expect(await trustDir("/x", { configFile: file, log, lockWaitMs: 100 })).toEqual({ written: ["/x"] });
    expect(await stat(`${file}.lock`).catch(() => null)).toBeNull();
  });

  test("同時の書き込みが互いを消さない", async () => {
    await Promise.all(["/a", "/b", "/c", "/d"].map((d) => trustDir(d, { configFile: file, log })));
    const p = (await json()).projects;
    for (const d of ["/a", "/b", "/c", "/d", "/keep"]) expect(p[d].hasTrustDialogAccepted).toBe(true);
  });

  test("git のルートを調べる処理が失敗しても cwd には書く", async () => {
    expect(await trustDir("/x", { configFile: file, gitRoot: async () => { throw new Error("no git"); }, log })).toEqual({ written: ["/x"] });
  });
});

describe("claudeConfigFile", () => {
  test("CLAUDE_CONFIG_DIR があればその中、無ければホーム", () => {
    expect(claudeConfigFile({ CLAUDE_CONFIG_DIR: "/p/ceo" }, "/home/u")).toBe("/p/ceo/.claude.json");
    expect(claudeConfigFile({}, "/home/u")).toBe("/home/u/.claude.json");
  });
});

describe("gitRootOf", () => {
  test("サブディレクトリからルートの実体のパス、git でなければ undefined", async () => {
    const repo = join(dir, "repo");
    await mkdir(join(repo, "sub"), { recursive: true });
    await bunRunner(["git", "init", "-q", repo]);
    expect(await gitRootOf(bunRunner)(join(repo, "sub"))).toBe(repo);
    const plain = join(dir, "plain");
    await mkdir(plain);
    // 試験の tmp が git の中にあることは無い前提（あればルートが返る）
    expect(await gitRootOf(bunRunner)(plain)).toBeUndefined();
  });
});
