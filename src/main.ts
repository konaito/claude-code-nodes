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

export function buildDeps(cfg: Config): Deps {
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
  };
}

async function account(): Promise<string | undefined> {
  try {
    const j = (await Bun.file(join(homedir(), ".claude.json")).json()) as { oauthAccount?: { emailAddress?: string } };
    return j.oauthAccount?.emailAddress;
  } catch { return undefined; }
}

if (import.meta.main) {
  const cfg = loadConfig();
  const app = createApp(buildDeps(cfg));
  Bun.serve({ hostname: "127.0.0.1", port: cfg.port, fetch: app.fetch, idleTimeout: 0 });
  console.log(`node on http://127.0.0.1:${cfg.port} (${cfg.name}, roots: ${cfg.roots.join(", ")})`);
}
