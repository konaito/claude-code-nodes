#!/usr/bin/env bun
// cc の入口。設定を読み、命令を実行して終了コードを返す
import { loadConfig } from "../config";
import { main } from "./commands";

if (import.meta.main) {
  const code = await main(process.argv.slice(2), { cfg: loadConfig(), env: process.env, out: (s) => console.log(s), fetchFn: fetch, stdin: () => Bun.stdin.text() });
  process.exit(code);
}
