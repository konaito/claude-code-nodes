#!/usr/bin/env bun
// CLI の入口。設定を読み、命令を実行して終了コードを返す。参加側の命令には本物の cf、常駐、端末をつなぐ
import { createReadStream, createWriteStream, writeFileSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { loadConfig, lobbyOf, type Config } from "../config";
import { appHomeOf, CONFIG_ENV, configDirOf, LEGACY_CONFIG_ENV, LEGACY_SERVICE_NAMING } from "../names";
import { bunRunner } from "../engine/agents";
import { realCf } from "../join/cf";
import { serviceManager } from "../join/services";
import { main } from "./commands";
import { joinCommands } from "./join-commands";
import { clientFor } from "./client";
import { localPlaces, type PullDeps } from "./teleport";

function ttyAsk(prompt: string): Promise<string> {
  return new Promise((resolve, reject) => {
    try {
      const input = createReadStream("/dev/tty");
      const output = createWriteStream("/dev/tty");
      const rl = createInterface({ input, output, terminal: true });
      rl.question(prompt, (answer) => { rl.close(); output.end(); resolve(answer); });
      input.on("error", reject);
    } catch (e) { reject(e); }
  });
}
async function clipboard(text: string): Promise<boolean> {
  const pbcopy = Bun.which("pbcopy");
  if (!pbcopy) return false;
  const p = Bun.spawn([pbcopy], { stdin: "pipe", stdout: "ignore", stderr: "ignore" });
  p.stdin.write(text);
  await p.stdin.end();
  return (await p.exited) === 0;
}

export async function run(argv: string[]): Promise<number> {
  const home = homedir();
  const join_ = joinCommands({
    cf: realCf,
    services: (platform, p) => serviceManager(platform, p, bunRunner),
    legacyServices: (platform, p) => serviceManager(platform, p, bunRunner, undefined, undefined, LEGACY_SERVICE_NAMING),
    platform: process.platform === "darwin" ? "darwin" : "linux",
    home, configDir: configDirOf(home), appDir: join(appHomeOf(home), "app"), configFile: process.env[CONFIG_ENV] ?? process.env[LEGACY_CONFIG_ENV],
    bunPath: process.execPath, cloudflaredPath: Bun.which("cloudflared") ?? join(home, ".local", "bin", "cloudflared"), uid: userInfo().uid,
    tty: ttyAsk, ttyWrite: (t) => writeFileSync("/dev/tty", t), clipboard, run: bunRunner, now: () => new Date(),
  });
  const cfg = loadConfig();
  return main(argv, { cfg, env: process.env, out: (s) => console.log(s), fetchFn: fetch, stdin: () => Bun.stdin.text(), join: join_, pullDeps: () => pullDeps(cfg, home) });
}

// 手元へ持ってくるときの道具。端末の claude と同じ CLAUDE_CONFIG_DIR（この CLI のプロセスの環境）に書く
async function pullDeps(cfg: Config, home: string): Promise<PullDeps> {
  const { importSessionToStore, forkSession, deleteSession, getSessionInfo } = await import("@anthropic-ai/claude-agent-sdk");
  const { bunGit } = await import("../teleport/git");
  const { claudeConfigDir } = await import("../teleport/transcript");
  const local = clientFor(cfg, undefined, undefined, process.env);
  return {
    teleport: { fns: { importSessionToStore, forkSession, deleteSession, getSessionInfo }, git: bunGit, configDir: claudeConfigDir() },
    place: { git: bunGit, home, roots: cfg.roots, lobby: lobbyOf(cfg, home), places: localPlaces(local, fetch) },
    interactive: !!process.stdin.isTTY && !!process.stdout.isTTY,
    open: async (cwd, id) => Bun.spawn(["claude", "--resume", id], { cwd, stdio: ["inherit", "inherit", "inherit"] }).exited,
    localLive: async (id) => {
      const r = await fetch(`${local.base}/api/sessions/${id}`, { headers: local.headers }).catch(() => undefined);
      if (!r || !r.ok) return false;
      const d = (await r.json().catch(() => ({}))) as { state?: string };
      return !!d.state && d.state !== "exited";
    },
  };
}

if (import.meta.main) process.exit(await run(process.argv.slice(2)));
