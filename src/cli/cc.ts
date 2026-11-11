#!/usr/bin/env bun
// 改名前の入口。旧の常駐（jp.fybe.cc.node、cc-node）と旧のインストーラは src/cli/cc.ts を呼ぶので、移行の間は残して ccn.ts に渡す
import { run } from "./ccn";

if (import.meta.main) process.exit(await run(process.argv.slice(2)));
