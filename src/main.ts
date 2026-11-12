// 組み立て。どの実装を使うかはここだけで決める。本物の SDK、claude、受信ソケットをつないで 127.0.0.1 で待つ
import { query, listSessions, getSessionMessages, getSessionInfo } from "@anthropic-ai/claude-agent-sdk";
import { homedir, loadavg, userInfo } from "node:os";
import { join } from "node:path";
import { loadConfig, type Config } from "./config";
import { createApp, type Deps } from "./api/app";
import { SessionStore } from "./sessions/store";
import { HeaderIdentity, type Identity } from "./identity/identity";
import { AccessIdentity } from "./identity/access";
import { History } from "./engine/history";
import { NodeDriver } from "./engine/node-driver";
import { TerminalDriver, unixConnect } from "./engine/terminal-driver";
import { PtyDriver, bunPtySpawn } from "./engine/pty-driver";
import { listAgents, bunRunner } from "./engine/agents";
import { StaticRegistry, type Registry } from "./registry/registry";
import { CloudflareRegistry } from "./registry/cloudflare";
import { Relay } from "./relay/relay";
import { defaultPath, entryOf, lobbyOf } from "./config";
import { prepareLobby } from "./lobby/lobby";

export function buildDeps(cfg: Config, configFile?: string): Deps {
  const registry = registryFor(cfg);
  return {
    nodeName: cfg.name,
    roots: cfg.roots,
    lobby: lobbyOf(cfg),
    store: new SessionStore(),
    identity: identityFor(cfg),
    history: new History({ listSessions, getSessionMessages, getSessionInfo }),
    startNode: (opts, caller) => NodeDriver.start(opts, { queryFn: query, nodeName: cfg.name, caller: caller.id, claudePath: Bun.which("claude") ?? undefined }),
    // PTY の子。hooks はノード自身（127.0.0.1）に送らせる。状態の照らし合わせは `claude agents --json` の pid で引く
    startPty: (opts, caller) => PtyDriver.start(opts, {
      spawn: bunPtySpawn, hookBase: `http://127.0.0.1:${cfg.port}`, caller: caller.id, claudePath: Bun.which("claude") ?? undefined,
      agentInfo: async (pid) => (await listAgents(bunRunner)).find((a) => a.pid === pid),
      transcript: (id) => getSessionMessages(id),
    }),
    agents: () => listAgents(bunRunner),
    terminalFor: (a) => new TerminalDriver(a, { uid: userInfo().uid, connect: unixConnect }),
    host: async () => ({ claudeVersion: (await bunRunner(["claude", "--version"])).stdout.trim(), account: await account(), load: loadavg() }),
    registry,
    relay: new Relay({ registry, nodeName: cfg.name, serviceToken: cfg.serviceToken }),
    appRoot: join(import.meta.dir, ".."),
    home: homedir(),
    configFile,
  };
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

async function account(): Promise<string | undefined> {
  try {
    const j = (await Bun.file(join(homedir(), ".claude.json")).json()) as { oauthAccount?: { emailAddress?: string } };
    return j.oauthAccount?.emailAddress;
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
    const live = store.list().filter((s) => s.kind === "pty" && s.state !== "exited").map((s) => store.get(s.id)).filter((d) => d !== undefined);
    await Promise.race([Promise.allSettled(live.map((d) => d.stop())), Bun.sleep(5000)]);
    exit(0);
  };
  if (listen) for (const sig of ["SIGTERM", "SIGINT", "SIGHUP"] as const) process.on(sig, () => void onSignal());
  return onSignal;
}

if (import.meta.main) start(loadConfig());
