import { test, expect } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cleanRemote, isProtected, MAC_PROTECTED, newPlacesMemory, nodeFs, PLACES_MAX_CHARS, PlacesScanner, protectedPaths, remoteOf, resolveCwds, scanPlaces, selectPlaces, usageOf, type PlacesFs } from "../../src/lobby/places";

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
  const all = (await scanPlaces({ roots: [root], bases: [root], lobby: join(root, "lobby") })).places;
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
  const all = (await scanPlaces({ roots: [root], bases: [root, home], lobby: join(root, "lobby") })).places;
  expect(all.map((p) => p.name)).not.toContain("homessh");
});

test("scanPlaces does not read the config file given by CCN_CONFIG", async () => {
  const { root } = fixture();
  mkdirSync(join(root, "cfgdir"));
  writeFileSync(join(root, "ccn-test.json"), "FAKE-CFG-6606\n");
  symlinkSync(join(root, "ccn-test.json"), join(root, "cfgdir", "README.md"));
  const all = (await scanPlaces({ roots: [root], bases: [root], configFile: join(root, "ccn-test.json") })).places;
  expect(all.find((p) => p.name === "cfgdir")!.readme).toEqual([]);
});

test("scanPlaces stops at maxDirs", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "ccn-places-many-")));
  for (let i = 0; i < 30; i++) mkdirSync(join(root, `p${i}`));
  expect((await scanPlaces({ roots: [root], bases: [root], maxDirs: 7 })).places.length).toBe(7);
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

// 止まる偽物の fs。本物の fs に、呼び出しの記録と、hang に当たるパスで返らない（gate を開けるまで待つ）振る舞いを足す
function trackedFs(hang: (p: string, op: string) => boolean = () => false, delay: (p: string, op: string) => number = () => 0) {
  const calls: Array<{ op: string; path: string }> = [];
  const gates: Array<() => void> = [];
  const wrap = <A extends unknown[], R>(op: string, f: (p: string, ...a: A) => Promise<R>) => async (p: string, ...a: A): Promise<R> => {
    calls.push({ op, path: p });
    if (hang(p, op)) await new Promise<void>((r) => gates.push(r));
    const ms = delay(p, op);
    if (ms) await new Promise((r) => setTimeout(r, ms));
    return f(p, ...a);
  };
  const fs: PlacesFs = {
    readdir: wrap("readdir", nodeFs.readdir), realpath: wrap("realpath", nodeFs.realpath), stat: wrap("stat", nodeFs.stat),
    lstat: wrap("lstat", nodeFs.lstat), readlink: wrap("readlink", nodeFs.readlink), readHead: wrap("readHead", nodeFs.readHead),
  };
  return { fs, calls, release: () => { for (const g of gates.splice(0)) g(); }, count: (op: string, path: string) => calls.filter((c) => c.op === op && c.path === path).length };
}

function macHome() {
  const home = realpathSync(mkdtempSync(join(tmpdir(), "ccn-places-mac-")));
  for (const n of [...MAC_PROTECTED, "Documents/app", "proj", "Library/Mobile Documents/com~apple~CloudDocs/doc"]) mkdirSync(join(home, n), { recursive: true });
  writeFileSync(join(home, "Desktop", "README.md"), "desktop\n");
  // ホームの直下の symlink の先が保護フォルダの中（iCloud Drive など）
  symlinkSync(join(home, "Library", "Mobile Documents", "com~apple~CloudDocs"), join(home, "cloud"));
  symlinkSync(join(home, "Downloads"), join(home, "dl"));
  return home;
}

test("on macOS scanPlaces never touches the protected folders in the home, not even with stat or realpath", async () => {
  const home = macHome();
  const prot = MAC_PROTECTED.map((n) => join(home, n));
  // 保護フォルダに当たったら返らない（本番の止まり方の再現）。当たらなければすぐ終わる
  const t = trackedFs((p) => isProtected(p, prot));
  const started = Date.now();
  const r = await scanPlaces({ roots: [home], bases: [home], home, platform: "darwin" }, { fs: t.fs, deadlineMs: 2000, opMs: 1000 });
  expect(Date.now() - started).toBeLessThan(500);
  expect(r.places.map((p) => p.name).sort()).toEqual(["app", "proj"]);
  expect(r.partial).toBe(false);
  expect(r.unreadable).toEqual([]);
  expect(t.calls.filter((c) => isProtected(c.path, prot))).toEqual([]);
  // symlink は readlink だけで、先（保護フォルダの中）には realpath も当てていない
  expect(t.count("readlink", join(home, "cloud"))).toBe(1);
  expect(t.count("realpath", join(home, "cloud"))).toBe(0);
  t.release();
});

test("on Linux the same names are ordinary places, and a root inside a protected folder is still scanned", async () => {
  const home = macHome();
  const linux = await scanPlaces({ roots: [home], bases: [home], home, platform: "linux" });
  expect(linux.places.map((p) => p.name)).toEqual(expect.arrayContaining(["Desktop", "Downloads", "Music", "Public", "proj"]));
  expect(linux.places.map((p) => p.name)).not.toContain("Library"); // 秘密の置き場（Library/Keychains）を含むので、どこでも外す
  const desk = await scanPlaces({ roots: [join(home, "Desktop")], bases: [home], home, platform: "darwin" });
  expect(desk.partial).toBe(false); // 利用者が roots に選んだ保護フォルダは、その下を読む
  expect(protectedPaths({ home, platform: "darwin", roots: [join(home, "Desktop")] })).not.toContain(join(home, "Desktop"));
});

test("a directory that does not answer is cut off by the per-call limit, reported as unreadable and the rest is returned", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "ccn-places-hang-")));
  for (const n of ["a", "b", "slow"]) mkdirSync(join(root, n));
  writeFileSync(join(root, "a", "README.md"), "a\n");
  const slow = join(root, "slow");
  const t = trackedFs((p, op) => p === slow && op === "readdir");
  const memory = newPlacesMemory();
  const started = Date.now();
  const r = await scanPlaces({ roots: [root], bases: [root], home: root, platform: "darwin" }, { fs: t.fs, memory, deadlineMs: 1000, opMs: 100 });
  expect(Date.now() - started).toBeLessThan(600);
  expect(r.places.map((p) => p.name).sort()).toEqual(["a", "b"]);
  expect(r.places.find((p) => p.name === "a")!.readme).toEqual(["a"]);
  expect(r).toMatchObject({ partial: true, unreadable: [slow] });
  expect(memory.stuck.has(slow)).toBe(true);
  // 次の走査では、止まったディレクトリを開かない（止まったスレッドを増やさない）。覚えていることは unreadable で伝える
  const again = await scanPlaces({ roots: [root], bases: [root], home: root, platform: "darwin" }, { fs: t.fs, memory, deadlineMs: 1000, opMs: 100 });
  expect(t.count("readdir", slow)).toBe(1);
  expect(again).toMatchObject({ partial: true, unreadable: [slow] });
  expect(again.places.map((p) => p.name).sort()).toEqual(["a", "b"]);
  // 呼び出しが後で返っても、ノードが動いている間は開かない
  t.release();
  await new Promise((r) => setTimeout(r, 10));
  await scanPlaces({ roots: [root], bases: [root], home: root, platform: "darwin" }, { fs: t.fs, memory, deadlineMs: 1000, opMs: 100 });
  expect(t.count("readdir", slow)).toBe(1);
});

test("when the whole scan runs out of time it returns what it has, and does not remember merely slow directories", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "ccn-places-late-")));
  for (let i = 0; i < 40; i++) mkdirSync(join(root, `p${i}`));
  // 候補の中を読むたびに 40ms かかる。8件ずつ読むので、200ms では全部は読めない
  const t = trackedFs(() => false, (p, op) => (op === "readdir" && p !== root ? 40 : 0));
  const memory = newPlacesMemory();
  const started = Date.now();
  const r = await scanPlaces({ roots: [root], bases: [root], home: root, platform: "darwin" }, { fs: t.fs, memory, deadlineMs: 200, opMs: 1000 });
  expect(Date.now() - started).toBeLessThan(400);
  expect(r.partial).toBe(true);
  expect(r.places.length).toBeGreaterThan(0);
  expect(r.places.length).toBeLessThan(40);
  expect(memory.stuck.size).toBe(0); // 遅いだけのものは覚えない
  await new Promise((r) => setTimeout(r, 60));
  const full = await scanPlaces({ roots: [root], bases: [root], home: root, platform: "darwin" }, { fs: t.fs, memory, deadlineMs: 3000, opMs: 1000 });
  expect(full).toMatchObject({ partial: false, unreadable: [] });
  expect(full.places).toHaveLength(40);
});

test("a call still in flight from an earlier scan is not issued again until it returns", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "ccn-places-pending-")));
  mkdirSync(join(root, "x"));
  const x = join(root, "x");
  let hanging = true; // 最初の1回だけ返らない
  const t = trackedFs((p, op) => p === x && op === "readdir" && hanging);
  const memory = newPlacesMemory();
  // 全体の時間切れで待ちを切っただけなので stuck には入れないが、返るまでは開かない
  const first = await scanPlaces({ roots: [root], bases: [root], home: root, platform: "darwin" }, { fs: t.fs, memory, deadlineMs: 100, opMs: 1000 });
  expect(first.partial).toBe(true);
  expect(memory.stuck.size).toBe(0);
  const second = await scanPlaces({ roots: [root], bases: [root], home: root, platform: "darwin" }, { fs: t.fs, memory, deadlineMs: 100, opMs: 1000 });
  expect(t.count("readdir", x)).toBe(1);
  expect(second.unreadable).toEqual([x]);
  hanging = false;
  t.release();
  await new Promise((r) => setTimeout(r, 10));
  expect(memory.pending.size).toBe(0);
  const third = await scanPlaces({ roots: [root], bases: [root], home: root, platform: "darwin" }, { fs: t.fs, memory, deadlineMs: 1000, opMs: 1000 });
  expect(t.count("readdir", x)).toBe(2);
  expect(third.places.map((p) => p.name)).toEqual(["x"]);
});

test("PlacesScanner shares one scan between concurrent calls and caches the finished result", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "ccn-places-sf-")));
  mkdirSync(join(root, "a"));
  const t = trackedFs(() => false, (p, op) => (op === "readdir" && p === root ? 50 : 0));
  const s = new PlacesScanner({ fs: t.fs, cacheMs: 100 });
  const o = { roots: [root], bases: [root], home: root, platform: "darwin" as const };
  const [r1, r2, r3] = await Promise.all([s.scan(o), s.scan(o), s.scan(o)]);
  expect(s.scans).toBe(1);
  expect(t.count("readdir", root)).toBe(1);
  expect(r1).toBe(r2);
  expect(r2).toBe(r3);
  await s.scan(o);
  expect(s.scans).toBe(1); // 終わってから cacheMs のうちは使い回す
  await new Promise((r) => setTimeout(r, 120));
  await s.scan(o);
  expect(s.scans).toBe(2);
});

test("resolveCwds leaves cwds outside roots and in protected folders as they are", async () => {
  const home = macHome();
  const t = trackedFs((p) => isProtected(p, MAC_PROTECTED.map((n) => join(home, n))));
  const m = await resolveCwds([join(home, "Desktop", "x"), "/elsewhere/y", join(home, "proj")], { roots: [home], home, platform: "darwin" }, { fs: t.fs });
  expect(m.get(join(home, "Desktop", "x"))).toBe(join(home, "Desktop", "x"));
  expect(m.get("/elsewhere/y")).toBe("/elsewhere/y");
  expect(m.get(join(home, "proj"))).toBe(join(home, "proj"));
  expect(t.calls.map((c) => c.path)).toEqual([join(home, "proj")]);
});
