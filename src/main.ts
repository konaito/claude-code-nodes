// 組み立て。どの実装を使うかはここだけで決める。本物の SDK、claude、受信ソケットをつないで 127.0.0.1 で待つ
import { query, listSessions, getSessionMessages, getSessionInfo } from "@anthropic-ai/claude-agent-sdk";
import { homedir, loadavg, userInfo } from "node:os";
import { join } from "node:path";
import { loadConfig, type Config } from "./config";
import { createApp, type Deps } from "./api/app";
import { SessionStore } from "./sessions/store";
import { HeaderIdentity } from "./identity/identity";
import { History } from "./engine/history";
import { NodeDriver } from "./engine/node-driver";
import { TerminalDriver, unixConnect } from "./engine/terminal-driver";
import { listAgents, bunRunner } from "./engine/agents";
import { StaticRegistry, type Registry } from "./registry/registry";
import { CloudflareRegistry } from "./registry/cloudflare";
import { Relay } from "./relay/relay";
import { entryOf } from "./config";

export function buildDeps(cfg: Config): Deps {
  const registry = registryFor(cfg);
  return {
    nodeName: cfg.name,
    roots: cfg.roots,
    store: new SessionStore(),
    identity: new HeaderIdentity(),
    history: new History({ listSessions, getSessionMessages, getSessionInfo }),
    startNode: (opts, caller) => NodeDriver.start(opts, { queryFn: query, nodeName: cfg.name, caller: caller.id, claudePath: Bun.which("claude") ?? undefined }),
    agents: () => listAgents(bunRunner),
    terminalFor: (a) => new TerminalDriver(a, { uid: userInfo().uid, connect: unixConnect }),
    host: async () => ({ claudeVersion: (await bunRunner(["claude", "--version"])).stdout.trim(), account: await account(), load: loadavg() }),
    registry,
    relay: new Relay({ registry, nodeName: cfg.name, serviceToken: cfg.serviceToken }),
    appRoot: join(import.meta.dir, ".."),
  };
}

// 登録簿。CF API トークンとアカウントがあれば Cloudflare のトンネル一覧、無ければ自分だけ
function registryFor(cfg: Config): Registry {
  if (cfg.cfApiToken && cfg.accountId && cfg.domain) {
    return new CloudflareRegistry({ accountId: cfg.accountId, apiToken: cfg.cfApiToken, domain: cfg.domain, selfName: cfg.name });
  }
  return new StaticRegistry([{ name: cfg.name, url: entryOf(cfg) ?? `http://127.0.0.1:${cfg.port}`, status: "healthy", self: true }]);
}

async function account(): Promise<string | undefined> {
  try {
    const j = (await Bun.file(join(homedir(), ".claude.json")).json()) as { oauthAccount?: { emailAddress?: string } };
    return j.oauthAccount?.emailAddress;
  } catch { return undefined; }
}

export function start(cfg: Config) {
  const app = createApp(buildDeps(cfg));
  const server = Bun.serve({ hostname: "127.0.0.1", port: cfg.port, fetch: app.fetch, idleTimeout: 0 });
  console.log(`node on http://127.0.0.1:${cfg.port} (${cfg.name}, roots: ${cfg.roots.join(", ")}, ${cfg.teamDomain && cfg.aud ? "access" : "no access"})`);
  return server;
}

if (import.meta.main) start(loadConfig());
