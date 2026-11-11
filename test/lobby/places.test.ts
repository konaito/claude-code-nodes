import { test, expect } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cleanRemote, PLACES_MAX_CHARS, remoteOf, scanPlaces, selectPlaces, usageOf } from "../../src/lobby/places";

// 目印。places の出力（JSON 全体）にどれも出てはいけない
const MARKS = ["FAKE-SSH-README-1101", "FAKE-ENV-2202", "FAKE-PEM-3303", "FAKE-TOKEN-4404", "FAKE-HDR-5505", "FAKE-CFG-6606", "FAKE-KEYCHAIN-7707", "FAKE-OUTSIDE-8808"];

function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "ccn-places-")));
  const outside = realpathSync(mkdtempSync(join(tmpdir(), "ccn-places-out-")));
  const w = (p: string, t: string) => { mkdirSync(join(root, p, ".."), { recursive: true }); writeFileSync(join(root, p), t); };
  // 秘密の置き場（README があっても候補にしない）
  w(".ssh/README.md", "FAKE-SSH-README-1101\n");
  w(".config/ccn/README.md", "FAKE-CFG-6606\n");
  w("Library/Keychains/README.md", "FAKE-KEYCHAIN-7707\n");
  w(".env", "FAKE-ENV-2202\n");
  // ふつうの候補
  w("notes/README.md", "# Notes\n\n[![badge](x)](y)\nメモを置く場所\n2行目\n3行目\n4行目\n5行目\n6行目\n");
  w("notes/.git/config", '[core]\n\tbare = false\n[remote "upstream"]\n\turl = git@github.com:o/up.git\n[remote "origin"]\n\turl = https://alice:FAKE-TOKEN-4404@github.com/o/notes.git\n[http]\n\textraheader = AUTHORIZATION: basic FAKE-HDR-5505\n');
  w("Documents/greeter/README", "greeter: 挨拶を出す\n");
  // README が秘密への symlink（読まない）
  mkdirSync(join(root, "Documents", "linked"), { recursive: true });
  symlinkSync(join(root, ".env"), join(root, "Documents", "linked", "README.md"));
  w("Documents/certs-app/x.pem", "FAKE-PEM-3303\n");
  symlinkSync(join(root, "Documents", "certs-app", "x.pem"), join(root, "Documents", "certs-app", "README.md"));
  // 候補のディレクトリが秘密や roots の外への symlink（候補にしない）
  symlinkSync(join(root, ".ssh"), join(root, "sshlink"));
  writeFileSync(join(outside, "README.md"), "FAKE-OUTSIDE-8808\n");
  symlinkSync(outside, join(root, "outlink"));
  // worktree（.git がファイル）。remote は本体の config から読む
  w("main-repo/.git/config", '[remote "origin"]\n\turl = https://github.com/o/main.git\n');
  mkdirSync(join(root, "main-repo", ".git", "worktrees", "wt"), { recursive: true });
  writeFileSync(join(root, "main-repo", ".git", "worktrees", "wt", "commondir"), "../..\n");
  w("wt/.git", `gitdir: ${join(root, "main-repo", ".git", "worktrees", "wt")}\n`);
  w("wt/README.md", "worktree\n");
  // 受け口自身は候補にしない
  w("lobby/CLAUDE.md", "lobby\n");
  return { root, outside };
}

test("scanPlaces lists the directories under the root and Documents with README, remote and no secrets", async () => {
  const { root } = fixture();
  const all = await scanPlaces({ roots: [root], bases: [root], lobby: join(root, "lobby") });
  const names = all.map((p) => p.name).sort();
  expect(names).toEqual(["certs-app", "greeter", "linked", "main-repo", "notes", "wt"]);
  const by = Object.fromEntries(all.map((p) => [p.name, p]));
  expect(by.notes!.path).toBe(join(root, "notes"));
  expect(by.notes!.readme).toEqual(["# Notes", "メモを置く場所", "2行目", "3行目", "4行目"]); // バッジの行を飛ばし5行まで
  expect(by.notes!.remote).toBe("https://github.com/o/notes.git"); // origin を先に、利用者名と token を消す
  expect(by.greeter!.readme).toEqual(["greeter: 挨拶を出す"]);
  expect(by.wt!.remote).toBe("https://github.com/o/main.git");
  expect(by.linked!.readme).toEqual([]);
  expect(by["certs-app"]!.readme).toEqual([]);
  const text = JSON.stringify(selectPlaces(all, new Map(), { q: "notes greeter linked certs wt" }));
  for (const m of MARKS) expect(text).not.toContain(m);
  expect(text).not.toContain("alice");
});

test("scanPlaces skips secret places under the node's home even when the home is not a root", async () => {
  const { root } = fixture();
  const home = realpathSync(mkdtempSync(join(tmpdir(), "ccn-places-home-")));
  mkdirSync(join(home, ".ssh"));
  symlinkSync(join(home, ".ssh"), join(root, "homessh"));
  writeFileSync(join(home, ".ssh", "README.md"), "FAKE-SSH-README-1101\n");
  const all = await scanPlaces({ roots: [root], bases: [root, home], lobby: join(root, "lobby") });
  expect(all.map((p) => p.name)).not.toContain("homessh");
});

test("scanPlaces does not read the config file given by CCN_CONFIG", async () => {
  const { root } = fixture();
  mkdirSync(join(root, "cfgdir"));
  writeFileSync(join(root, "ccn-test.json"), "FAKE-CFG-6606\n");
  symlinkSync(join(root, "ccn-test.json"), join(root, "cfgdir", "README.md"));
  const all = await scanPlaces({ roots: [root], bases: [root], configFile: join(root, "ccn-test.json") });
  expect(all.find((p) => p.name === "cfgdir")!.readme).toEqual([]);
});

test("scanPlaces stops at maxDirs", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "ccn-places-many-")));
  for (let i = 0; i < 30; i++) mkdirSync(join(root, `p${i}`));
  expect((await scanPlaces({ roots: [root], bases: [root], maxDirs: 7 })).length).toBe(7);
});

test("selectPlaces puts recently used places first, narrows by words and caps count and characters", async () => {
  const many = Array.from({ length: 400 }, (_, i) => ({ name: `p${i}`, path: `/r/p${i}`, remote: null, readme: [`readme of p${i} ${"x".repeat(150)}`, "second"], mtimeMs: i }));
  const used = usageOf(many, [{ cwd: "/r/p3/sub", lastActivityAt: 50 }, { cwd: "/r/p7", lastActivityAt: 90 }, { cwd: "/r/p30x", lastActivityAt: 99 }]);
  const r = selectPlaces(many, used);
  expect(r.places[0]!.path).toBe("/r/p7");
  expect(r.places[1]!.path).toBe("/r/p3");
  expect(r.places[0]!.lastUsedAt).toBe(90);
  expect(r.places[2]!.path).toBe("/r/p399"); // 使っていないものは変更の新しい順
  expect(r.places.length).toBe(60);           // 既定の件数
  expect(r.places[0]!.readme).toHaveLength(1); // 絞らないときは README の先頭2行を1行にして160字まで
  expect(r.places[0]!.readme[0]!.startsWith("readme of p7 ")).toBe(true);
  expect(r.places[0]!.readme[0]!.length).toBeLessThanOrEqual(161);
  expect(selectPlaces([{ ...many[0]!, readme: ["# a", "説明"] }], new Map()).places[0]!.readme).toEqual(["# a / 説明"]);
  expect(r.total).toBe(400);
  expect(r.truncated).toBe(true);
  const big = selectPlaces(many, used, { limit: 300 });
  expect(JSON.stringify(big.places).length).toBeLessThanOrEqual(PLACES_MAX_CHARS);
  expect(big.truncated).toBe(true);
  expect(selectPlaces(many, used, { limit: 10_000 }).places.length).toBeLessThanOrEqual(300);
  const q = selectPlaces(many, used, { q: "P12 nothing-matches" });
  expect(q.places.map((p) => p.path)).toEqual(["/r/p12", "/r/p120", "/r/p121", "/r/p122", "/r/p123", "/r/p124", "/r/p125", "/r/p126", "/r/p127", "/r/p128", "/r/p129"].sort((a, b) => Number(b.slice(4)) - Number(a.slice(4))));
  expect(q.places[0]!.readme).toHaveLength(2);
});

test("remoteOf reads only remote urls and cleanRemote drops user names and tokens", () => {
  expect(remoteOf('[remote "origin"]\n\turl = https://x:y@h/o/r.git\n\tpushurl = nope\n')).toBe("https://h/o/r.git");
  expect(remoteOf("[core]\n\turl = not-a-remote\n")).toBeNull();
  expect(remoteOf('[remote "a"]\n url = git@h:o/a.git\n')).toBe("git@h:o/a.git");
  expect(cleanRemote("ssh://git@h:22/o/r.git")).toBe("ssh://h:22/o/r.git");
  expect(cleanRemote("https://h/o/r.git")).toBe("https://h/o/r.git");
});
