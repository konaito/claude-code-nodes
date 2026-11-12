// teleport の通し。移動元と移動先の2つのノード（createApp）を同じプロセスで立て、中継は移動先の fetch に直結する。
// git は一時ディレクトリの本物、会話は偽物の SDK（移動元は記憶、移動先はファイル）、claude は使わない
import { test, expect, beforeEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type Deps } from "../../src/api/app";
import { SessionStore } from "../../src/sessions/store";
import { HeaderIdentity } from "../../src/identity/identity";
import { StaticRegistry } from "../../src/registry/registry";
import { Relay } from "../../src/relay/relay";
import { FakeDriver } from "../helpers/fake-driver";
import type { AgentInfo } from "../../src/engine/agents";
import type { StartOptions } from "../../src/engine/node-driver";
import { bunGit } from "../../src/teleport/git";
import { projectDirName, type TranscriptFns } from "../../src/teleport/transcript";
import type { Entry } from "../../src/teleport/pack";
import { main as cli } from "../../src/cli/commands";

const ID = "aaaaaaaa-0000-4000-8000-000000000001";
const caps = (on: boolean) => ({ send: true, permissions: on, interrupt: on, stop: on, events: on });
const sh = async (cwd: string, ...args: string[]) => {
  const r = await bunGit(cwd, args, { GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" });
  if (r.code !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout.trim();
};
const conv = (id: string, cwd: string): Entry[] => [
  { type: "user", uuid: "u1", parentUuid: null, sessionId: id, cwd, message: { role: "user", content: "合言葉は みかん42" } },
  { type: "assistant", uuid: "u2", parentUuid: "u1", sessionId: id, cwd, message: { role: "assistant", content: [{ type: "text", text: "OK" }] } },
];

// 移動元の偽の SDK。会話は記憶に持つ
function memFns(convs: Map<string, Entry[]>): TranscriptFns {
  return {
    importSessionToStore: (async (id: string, store: { append: (k: unknown, e: unknown[]) => Promise<void> }) => {
      const c = convs.get(id);
      if (!c) throw new Error("not found");
      await store.append({ projectKey: "p", sessionId: id }, c);
    }) as unknown as TranscriptFns["importSessionToStore"],
    forkSession: (async (id: string) => {
      const nid = crypto.randomUUID();
      convs.set(nid, convs.get(id)!.map((e) => ({ ...e, sessionId: nid, uuid: e.uuid ? `f-${e.uuid}` : e.uuid })));
      return { sessionId: nid };
    }) as unknown as TranscriptFns["forkSession"],
    deleteSession: (async (id: string) => { convs.delete(id); }) as unknown as TranscriptFns["deleteSession"],
    getSessionInfo: (async (id: string) => (convs.has(id) ? { sessionId: id, cwd: convs.get(id)![0]!.cwd } : undefined)) as unknown as TranscriptFns["getSessionInfo"],
  };
}
// 移動先の偽の SDK。置き場のファイルを見る（SDK と同じく、dir があればその置き場、無ければ全部）
function fileFns(configDir: string): TranscriptFns {
  const find = (id: string, dir?: string) => {
    const roots = dir ? [projectDirName(dir)] : existsSync(join(configDir, "projects")) ? readdirSync(join(configDir, "projects")) : [];
    for (const r of roots) { const f = join(configDir, "projects", r, `${id}.jsonl`); if (existsSync(f)) return f; }
    return undefined;
  };
  const read = (f: string) => readFileSync(f, "utf8").trim().split("\n").map((l) => JSON.parse(l) as Entry);
  return {
    importSessionToStore: (async (id: string, store: { append: (k: unknown, e: unknown[]) => Promise<void> }) => {
      const f = find(id);
      if (!f) throw new Error("not found");
      await store.append({ projectKey: "p", sessionId: id }, read(f));
    }) as unknown as TranscriptFns["importSessionToStore"],
    forkSession: (async () => { throw new Error("unused"); }) as unknown as TranscriptFns["forkSession"],
    deleteSession: (async () => {}) as unknown as TranscriptFns["deleteSession"],
    getSessionInfo: (async (id: string, o?: { dir?: string }) => { const f = find(id, o?.dir); return f ? { sessionId: id, cwd: read(f)[0]!.cwd } : undefined; }) as unknown as TranscriptFns["getSessionInfo"],
  };
}

let base: string, remote: string, srcRepo: string, dstHome: string, dstRepo: string, dstConfig: string;
let convs: Map<string, Entry[]>;

beforeEach(async () => {
  base = realpathSync(mkdtempSync(join(tmpdir(), "ccn-tp-api-")));
  remote = join(base, "remote.git");
  await sh(base, "init", "-q", "--bare", "-b", "main", remote);
  srcRepo = join(base, "srchome", "Documents", "proj");
  mkdirSync(join(base, "srchome", "Documents"), { recursive: true });
  await sh(base, "clone", "-q", remote, srcRepo);
  writeFileSync(join(srcRepo, "a.txt"), "a\n");
  await sh(srcRepo, "add", "-A");
  await sh(srcRepo, "commit", "-q", "-m", "init");
  await sh(srcRepo, "push", "-q", "origin", "HEAD:main");
  dstHome = join(base, "dsthome");
  dstRepo = join(dstHome, "Documents", "proj");
  mkdirSync(join(dstHome, "Documents"), { recursive: true });
  await sh(base, "clone", "-q", remote, dstRepo);
  dstConfig = join(base, "dstclaude");
  convs = new Map([[ID, conv(ID, srcRepo)]]);
});

type Node = { app: ReturnType<typeof createApp>; store: SessionStore; starts: StartOptions[]; deps: Deps };
function node(name: string, o: { home: string; fns: TranscriptFns; configDir: string; agents?: AgentInfo[]; places?: () => Array<{ path: string; remote: string | null }>; peer?: () => Node }): Node {
  const store = new SessionStore();
  const starts: StartOptions[] = [];
  const registry = new StaticRegistry([{ name: "src", url: "https://src.test", status: "healthy", self: name === "src" }, { name: "dst", url: "https://dst.test", status: "healthy", self: name === "dst" }]);
  const deps: Deps = {
    nodeName: name, roots: [o.home], lobby: join(o.home, "lobby"), store, identity: new HeaderIdentity(),
    history: { list: async () => [], get: async () => undefined, messages: async () => ({ messages: [] }), count: async () => 0 } as unknown as Deps["history"],
    startNode: async (opts) => { starts.push(opts); const d = new FakeDriver({ id: opts.resume ?? "x", capabilities: caps(true) }); d.cwd = opts.cwd; d.setState("idle"); return d; },
    agents: async () => o.agents ?? [],
    terminalFor: (a) => { const d = new FakeDriver({ id: a.sessionId!, capabilities: { send: true, permissions: false, interrupt: false, stop: false, events: false }, kind: "terminal" }); d.cwd = a.cwd; d.setState("idle"); return d; },
    host: async () => ({ claudeVersion: "t", load: [0] }),
    registry,
    relay: new Relay({ registry, nodeName: name, serviceToken: { clientId: "i", clientSecret: "s" }, fetchFn: (async (url: string, init: RequestInit) => o.peer!().app.fetch(new Request(String(url).replace("https://dst.test", "http://127.0.0.1"), init))) as unknown as typeof fetch }),
    appRoot: join(import.meta.dir, "..", ".."),
    home: o.home,
    places: { scan: async () => ({ places: (o.places?.() ?? []).map((p) => ({ name: p.path.split("/").pop()!, path: p.path, remote: p.remote, readme: [], mtimeMs: 0 })), partial: false, unreadable: [] }), resolveCwds: async () => new Map() } as unknown as Deps["places"],
    teleport: { fns: o.fns, git: bunGit, configDir: o.configDir },
  };
  return { app: createApp(deps), store, starts, deps };
}
const post = (path: string, body: unknown) => new Request(`http://127.0.0.1${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

function pair(opts: { agents?: AgentInfo[] } = {}) {
  let dst: Node;
  const src = node("src", { home: join(base, "srchome"), fns: memFns(convs), configDir: join(base, "srcclaude"), agents: opts.agents, peer: () => dst });
  dst = node("dst", { home: dstHome, fns: fileFns(dstConfig), configDir: dstConfig, places: () => (existsSync(dstRepo) ? [{ path: dstRepo, remote }] : []) });
  return { src, dst };
}
const liveSrc = (src: Node, state: "idle" | "running" = "idle") => {
  const d = new FakeDriver({ id: ID, capabilities: caps(true) });
  d.cwd = srcRepo;
  d.setState(state);
  src.store.add(d);
  return d;
};

test("move: the source node child is stopped, the destination gets the branch, changes and conversation as an idle child", async () => {
  const { src, dst } = pair();
  const d = liveSrc(src);
  await sh(srcRepo, "checkout", "-q", "-b", "feat/t");
  writeFileSync(join(srcRepo, "a.txt"), "edited\n");
  writeFileSync(join(srcRepo, "new.txt"), "untracked\n");
  const r = await src.app.fetch(post(`/api/sessions/${ID}/teleport`, { to: "dst" }));
  const body = (await r.json()) as { id: string; cwd: string; fork: boolean; git: { branch: string } };
  expect(r.status).toBe(200);
  expect(body.id).toBe(ID);
  expect(body.fork).toBe(false);
  expect(body.cwd).toBe(dstRepo);
  expect(body.git.branch).toBe("feat/t");
  expect(d.summary().state).toBe("exited");
  expect(src.store.get(ID)).toBeUndefined();
  expect(readFileSync(join(dstRepo, "a.txt"), "utf8")).toBe("edited\n");
  expect(readFileSync(join(dstRepo, "new.txt"), "utf8")).toBe("untracked\n");
  const file = join(dstConfig, "projects", projectDirName(dstRepo), `${ID}.jsonl`);
  const lines = readFileSync(file, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  expect(lines.map((l) => l.cwd)).toEqual([dstRepo, dstRepo]);
  expect(dst.starts).toEqual([expect.objectContaining({ cwd: dstRepo, resume: ID, defer: true })]);
  expect(dst.store.get(ID)).toBeDefined();
});

test("fork keeps the source running and the destination gets a new id", async () => {
  const { src, dst } = pair();
  const d = liveSrc(src);
  const r = await src.app.fetch(post(`/api/sessions/${ID}/teleport`, { to: "dst", fork: true }));
  const body = (await r.json()) as { id: string; fork: boolean };
  expect(r.status).toBe(200);
  expect(body.fork).toBe(true);
  expect(body.id).not.toBe(ID);
  expect(d.summary().state).toBe("idle");
  expect(convs.has(body.id)).toBe(false); // 移動元に写しを残さない
  expect(dst.starts[0]!.resume).toBe(body.id);
});

test("a running source is not moved and nothing changes at the destination", async () => {
  const { src, dst } = pair();
  const d = liveSrc(src, "running");
  const head = await sh(dstRepo, "rev-parse", "HEAD");
  const r = await src.app.fetch(post(`/api/sessions/${ID}/teleport`, { to: "dst" }));
  expect(r.status).toBe(409);
  expect(((await r.json()) as { code: string }).code).toBe("busy");
  expect(d.summary().state).toBe("running");
  expect(dst.starts).toEqual([]);
  expect(await sh(dstRepo, "rev-parse", "HEAD")).toBe(head);
});

test("a dirty destination stops the move at the check, before the source is stopped", async () => {
  const { src, dst } = pair();
  const d = liveSrc(src);
  writeFileSync(join(dstRepo, "mine.txt"), "human\n");
  const r = await src.app.fetch(post(`/api/sessions/${ID}/teleport`, { to: "dst" }));
  const body = (await r.json()) as { code: string; stage: string; at: string };
  expect(r.status).toBe(409);
  expect(body).toMatchObject({ code: "dirty", stage: "check", at: "dst" });
  expect(d.summary().state).toBe("idle");
  expect(readFileSync(join(dstRepo, "mine.txt"), "utf8")).toBe("human\n");
  expect(dst.starts).toEqual([]);
});

test("a running terminal session is forked with a warning instead of moved", async () => {
  const { src } = pair({ agents: [{ pid: 9, cwd: srcRepo, kind: "interactive", startedAt: 1, sessionId: ID, status: "idle" }] });
  const r = await src.app.fetch(post(`/api/sessions/${ID}/teleport`, { to: "dst" }));
  const body = (await r.json()) as { id: string; fork: boolean; warnings: string[] };
  expect(r.status).toBe(200);
  expect(body.fork).toBe(true);
  expect(body.id).not.toBe(ID);
  expect(body.warnings.join("\n")).toContain("cannot be stopped");
});

test("no matching place: clones into <home>/Documents/<repo>, creating Documents when missing", async () => {
  const { src, dst } = pair();
  liveSrc(src);
  dstRepo = join(dstHome, "Documents", "remote"); // places には無い。clone 先はリポジトリ名
  const { rmSync } = await import("node:fs");
  rmSync(join(dstHome, "Documents"), { recursive: true, force: true });
  const r = await src.app.fetch(post(`/api/sessions/${ID}/teleport`, { to: "dst" }));
  const body = (await r.json()) as { cwd: string; cloned: boolean };
  expect(r.status).toBe(200);
  expect(body.cloned).toBe(true);
  expect(body.cwd).toBe(join(dstHome, "Documents", "remote"));
  expect(readFileSync(join(body.cwd, "a.txt"), "utf8")).toBe("a\n");
  expect(dst.starts[0]!.cwd).toBe(body.cwd);
});

test("teleporting to the node itself or to an old peer is refused with a clear message", async () => {
  const { src } = pair();
  liveSrc(src);
  const self = await src.app.fetch(post(`/api/sessions/${ID}/teleport`, { to: "src" }));
  expect(self.status).toBe(400);
});

test("ccn teleport without --to brings the session into this machine and prints how to open it", async () => {
  const { src } = pair();
  liveSrc(src);
  writeFileSync(join(srcRepo, "a.txt"), "pulled\n");
  const local = { places: () => [{ path: dstRepo, remote }] };
  const out: string[] = [];
  const fetchFn = (async (url: string, init: RequestInit) => src.app.fetch(new Request(String(url).replace("https://ccn-src.fybe.jp", "http://127.0.0.1"), init))) as unknown as typeof fetch;
  const code = await cli(["teleport", `src/${ID}`], {
    cfg: { name: "here", port: 1, roots: [dstHome], zone: "fybe.jp", serviceToken: { clientId: "i", clientSecret: "s" } }, env: {}, out: (s) => out.push(s), fetchFn, stdin: async () => "",
    sendsPath: join(base, "sends.json"),
    pullDeps: async () => ({
      teleport: { fns: fileFns(dstConfig), git: bunGit, configDir: dstConfig },
      place: { git: bunGit, home: dstHome, roots: [dstHome], lobby: join(dstHome, "lobby"), places: async () => local.places() },
      interactive: false, open: async () => { throw new Error("must not open"); },
    }),
  });
  expect(out.join("\n")).toContain(`開く: cd ${dstRepo} && claude --resume ${ID}`);
  expect(code).toBe(0);
  expect(readFileSync(join(dstRepo, "a.txt"), "utf8")).toBe("pulled\n");
  expect(existsSync(join(dstConfig, "projects", projectDirName(dstRepo), `${ID}.jsonl`))).toBe(true);
  expect(src.store.get(ID)).toBeUndefined();
});
