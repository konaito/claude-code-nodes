#!/usr/bin/env bun
// cc の入口。設定を読み、命令を実行して終了コードを返す。参加側の命令には本物の cf、常駐、端末をつなぐ
import { createReadStream, createWriteStream, writeFileSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { loadConfig } from "../config";
import { bunRunner } from "../engine/agents";
import { realCf } from "../join/cf";
import { serviceManager } from "../join/services";
import { main } from "./commands";
import { joinCommands } from "./join-commands";

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

if (import.meta.main) {
  const home = homedir();
  const join_ = joinCommands({
    cf: realCf,
    services: (platform, p) => serviceManager(platform, p, bunRunner),
    platform: process.platform === "darwin" ? "darwin" : "linux",
    home, configDir: join(home, ".config", "cc"), appDir: join(home, ".local", "share", "cc", "app"),
    bunPath: process.execPath, cloudflaredPath: Bun.which("cloudflared") ?? join(home, ".local", "bin", "cloudflared"), uid: userInfo().uid,
    tty: ttyAsk, ttyWrite: (t) => writeFileSync("/dev/tty", t), clipboard, run: bunRunner, now: () => new Date(),
  });
  const code = await main(process.argv.slice(2), { cfg: loadConfig(), env: process.env, out: (s) => console.log(s), fetchFn: fetch, stdin: () => Bun.stdin.text(), join: join_ });
  process.exit(code);
}
