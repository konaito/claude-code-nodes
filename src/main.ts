// 組み立て。どの実装を使うかはここだけで決める。本物の SDK、claude、受信ソケットをつないで 127.0.0.1 で待つ
import { query, listSessions, getSessionMessages, getSessionInfo, importSessionToStore, forkSession, deleteSession } from "@anthropic-ai/claude-agent-sdk";
import { homedir, loadavg, userInfo } from "node:os";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { loadConfig, type Config } from "./config";
import { createApp, type Deps } from "./api/app";
import { SessionStore } from "./sessions/store";
import { DEFAULT_IDLE_STOP_MS } from "./sessions/idle-stop";
import { HeaderIdentity, type Identity } from "./identity/identity";
import { AccessIdentity } from "./identity/access";
import { History } from "./engine/history";
import { NodeDriver } from "./engine/node-driver";
import { TerminalDriver, unixConnect } from "./engine/terminal-driver";
import { PtyDriver, bunPtySpawn } from "./engine/pty-driver";
import { listAgents, withoutHeadless, bunRunner } from "./engine/agents";
import { claudeConfigFile, gitRootOf, trustDir } from "./engine/trust";
import { accountPreparer, bunExec, camAccount, pidAccount } from "./engine/account";
import { StaticRegistry, type Registry } from "./registry/registry";
import { CloudflareRegistry } from "./registry/cloudflare";
import { Relay } from "./relay/relay";
import { defaultPath, entryOf, lobbyOf } from "./config";
import { prepareLobby } from "./lobby/lobby";
import { bunGit } from "./teleport/git";
import { claudeConfigDir } from "./teleport/transcript";

export function buildDeps(cfg: Config, configFile?: string): Deps {
  const registry = registryFor(cfg);
  const acct = accountSetup();
  return {
    nodeName: cfg.name,
    roots: cfg.roots,
    lobby: lobbyOf(cfg),
    store: new SessionStore({ idleStopMs: (cfg.idleStopMinutes ?? DEFAULT_IDLE_STOP_MS / 60_000) * 60_000 }),
    identity: identityFor(cfg),
    history: new History({ listSessions, getSessionMessages, getSessionInfo }),
    // 子の claude は cam auto と同じアカウントで起動する（src/engine/account.ts）。node の子は起動の直前（遅延起動なら1通目）に選ぶ
    startNode: (opts, caller) => NodeDriver.start(opts, { queryFn: query, nodeName: cfg.name, caller: caller.id, claudePath: Bun.which("claude") ?? undefined, prepare: acct.prepare }),
    // 作成の応答と引き継ぎが、選んだ結果（枠の残るアカウントが無いか）を読む。引き継ぎは fresh で取り直す
    account: acct.pick,
    // 端末のセッションのアカウントは、プロセスの環境の CLAUDE_CONFIG_DIR から読む
    terminalAccount: (a) => acct.ofPid(a.pid, a.startedAt),
    // PTY の子。hooks はノード自身（127.0.0.1）に送らせる。状態の照らし合わせは `claude agents --json` の pid で引く
    startPty: async (opts, caller) => {
      const p = await acct.prepare(opts.cwd);
      return PtyDriver.start(opts, {
        env: p.env, account: p.account, accountEmail: p.accountEmail,
        spawn: bunPtySpawn, hookBase: `http://127.0.0.1:${cfg.port}`, caller: caller.id, claudePath: Bun.which("claude") ?? undefined,
        agentInfo: async (pid) => (await listAgents(bunRunner)).find((a) => a.pid === pid),
        // dir は起動した cwd。見つからなければ（cwd の書き方が違うときなど）全部のプロジェクトから探す
        transcript: async (id, dir) => { const m = dir ? await getSessionMessages(id, { dir }).catch(() => []) : []; return m.length ? m : getSessionMessages(id); },
      });
    },
    // 子に渡すのと同じ環境（process.env。childEnv も SDK も CLAUDE_CONFIG_DIR を落とさない）から、claude が読む設定ファイルを決める
    trust: (cwd) => trustDir(cwd, { configFile: claudeConfigFile(process.env, homedir()), gitRoot: gitRootOf(bunRunner) }),
    // 一覧には裏方の `claude -p` を出さない。PTY の子の状態合わせ（agentInfo）には掛けない
    agents: async () => withoutHeadless(await listAgents(bunRunner), bunRunner),
    terminalFor: (a) => new TerminalDriver(a, { uid: userInfo().uid, connect: unixConnect }),
    host: async () => ({ claudeVersion: (await bunRunner(["claude", "--version"])).stdout.trim(), account: await account(), load: loadavg() }),
    registry,
    relay: new Relay({ registry, nodeName: cfg.name, serviceToken: cfg.serviceToken }),
    appRoot: join(import.meta.dir, ".."),
    home: homedir(),
    configFile,
    // teleport の取り込みは、ノードを動かしている Claude の設定ディレクトリ（CLAUDE_CONFIG_DIR か ~/.claude）に書く
    notifyParent: cfg.notifyParent === false ? false : undefined,
    teleport: { fns: { importSessionToStore, forkSession, deleteSession, getSessionInfo }, git: bunGit, configDir: claudeConfigDir() },
  };
}

const PS_TIMEOUT_MS = 2000; // 端末のセッションのアカウントを読む ps を待つ上限
// 子のアカウントの用意。cam は launchd の PATH（~/.cam/bin を含まない）でも見つかるよう、~/.cam/bin/cam も見る。
// pick は選ぶ関数、prepare は起動の直前の用意、ofPid は端末のセッションのアカウント（プロセスの環境から読む）
function accountSetup() {
  const home = homedir();
  const fallback = join(home, ".cam", "bin", "cam");
  const cam = Bun.which("cam") ?? (existsSync(fallback) ? fallback : undefined);
  const profilesDir = join(home, ".cam", "profiles");
  const pick = camAccount({ cam, profilesDir, exec: bunExec, log: (m) => console.log(m) });
  const prepare = accountPreparer({
    pick, env: () => process.env,
    sync: async (name) => { if (cam) await bunExec([cam, "sync", name], 5000); },
    trust: (cwd, configFile) => trustDir(cwd, { configFile, gitRoot: gitRootOf(bunRunner) }),
  });
  // 端末のセッションの email。cam usage をまだ読んでいなければ（ノードの起動の直後）、プロファイルの .claude.json から読む
  const fromFile = new Map<string, Promise<string | undefined>>();
  const emailOf = (name: string) => {
    const known = pick.emailOf(name);
    if (known) return known;
    if (!fromFile.has(name)) fromFile.set(name, emailIn(join(profilesDir, name, ".claude.json")));
    return fromFile.get(name)!;
  };
  // ps は2秒で打ち切って kill する（pidAccount も同じ上限で待つのをやめる）。一覧が毎回ここを通るので、返らない ps で止めない
  return { pick, prepare, ofPid: pidAccount({ profilesDir, run: (argv) => bunExec(argv, PS_TIMEOUT_MS), emailOf, timeoutMs: PS_TIMEOUT_MS }) };
}

// 呼び手。Access の teamDomain と aud があれば JWT を検証する（仕様 2.1）。無ければ 127.0.0.1 の試験用にヘッダだけを見る
function identityFor(cfg: Config): Identity {
  return cfg.teamDomain && cfg.aud ? new AccessIdentity({ teamDomain: cfg.teamDomain, aud: cfg.aud }) : new HeaderIdentity();
}

// 登録簿。CF API トークンとアカウントがあれば Cloudflare のトンネル一覧、無ければ自分だけ
function registryFor(cfg: Config): Registry {
  const zone = cfg.zone ?? cfg.domain?.split(".").slice(1).join(".");
  if (cfg.cfApiToken && cfg.accountId && zone) {
    return new CloudflareRegistry({ accountId: cfg.accountId, apiToken: cfg.cfApiToken, zone, selfName: cfg.name });
  }
  return new StaticRegistry([{ name: cfg.name, url: entryOf(cfg) ?? `http://127.0.0.1:${cfg.port}`, status: "healthy", self: true }]);
}

const account = () => emailIn(join(homedir(), ".claude.json"));
// Claude Code の設定ファイルから、ログインしているアカウントの email を読む。読めなければ undefined
async function emailIn(file: string): Promise<string | undefined> {
  try {
    const j = (await Bun.file(file).json()) as { oauthAccount?: { emailAddress?: string } };
    return j.oauthAccount?.emailAddress || undefined;
  } catch { return undefined; }
}

export function start(cfg: Config, configPath = defaultPath()) {
  // 受け口を用意する。入れ替え前の旧コードが走る初回の ccn update では update の中の処理が動かないので、起動のたびにここでも行う
  const lb = prepareLobby({ dir: lobbyOf(cfg), appRoot: join(import.meta.dir, ".."), nodeName: cfg.name, roots: cfg.roots, home: homedir(), configFile: configPath });
  if ("error" in lb) console.error(`lobby ${lb.dir}: ${lb.error}`);
  const lobby = "error" in lb ? undefined : lb.dir;
  const deps = buildDeps(cfg, configPath);
  const app = createApp(deps);
  const server = Bun.serve({ hostname: "127.0.0.1", port: cfg.port, fetch: app.fetch, idleTimeout: 0 });
  stopPtysOnExit(deps.store);
  console.log(`node on http://127.0.0.1:${cfg.port} (${cfg.name}, roots: ${cfg.roots.join(", ")}, lobby: ${lobby ?? "none"}, ${cfg.teamDomain && cfg.aud ? "access" : "no access"})`);
  return server;
}

// ノードが止まるとき（launchd と systemd は SIGTERM を送る）、PTY の子の claude も止める。
// PTY を閉じても claude は終わらず、親を失って残った（2026-11-12 に試験ノードで確認）。SIGKILL で落ちたときは止められない
export function stopPtysOnExit(store: SessionStore, exit: (code: number) => void = (c) => process.exit(c), listen = true) {
  let stopping = false;
  const onSignal = async () => {
    if (stopping) return;
    stopping = true;
    store.quiet(); // 止める途中の exited を親に知らせない
    const live = store.list().filter((s) => s.kind === "pty" && s.state !== "exited").map((s) => store.get(s.id)).filter((d) => d !== undefined);
    await Promise.race([Promise.allSettled(live.map((d) => d.stop())), Bun.sleep(5000)]);
    exit(0);
  };
  if (listen) for (const sig of ["SIGTERM", "SIGINT", "SIGHUP"] as const) process.on(sig, () => void onSignal());
  return onSignal;
}

if (import.meta.main) start(loadConfig());
