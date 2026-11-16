# 子を cam auto のアカウントで起動する（2026-11-16）

## 起きたこと

Claude Town から開いたセッションが「You've hit your 5-hour limit」で止まった。ノードは子の claude を `CLAUDE_CONFIG_DIR` なしで起動していた。そのため子は `~/.claude` と `~/.claude.json` を使い、そのログインは5時間枠が100%の coo@fybe.jp だった。

## 直したこと

`src/engine/account.ts` が、子を起動する前に `cam usage --json` の `best` を読む。`~/.cam/profiles/<best>` があれば、子の環境の `CLAUDE_CONFIG_DIR` をそのパスにする。node の子は起動の直前に選び、PTY の子は作成のときに選ぶ。

## 確かめたこと

試験ノードを別のポート（8799、8798）と別の `CCN_CONFIG` で立てた。環境は `env -i` で launchd の plist と同じ `HOME` と `PATH` にした。この会話は shared のプロファイルで動いているので、環境を引き継ぐと直す前でも子が shared になり、違いが見えないため。

| 試験 | 結果 |
| --- | --- |
| coo で `claude -p` を起動する | `You've hit your 5-hour limit · resets 9:30pm`。会話 b6c336b0 の jsonl ができた |
| b6c336b0 を `terminal: true` と `resume` で付け直す | 子（pid 19168）の環境が `CLAUDE_CONFIG_DIR=/Users/konaito/.cam/profiles/shared`。返事は `RESUMED-OK` |
| 新しい node の子（prompt つき） | 子（pid 22454）の環境が同じく shared。返事は `NODE-OK` |
| cam を `best: agent` を返すスタブに差し替え、prompt なしで作ってから send する | send の前は子が無い。send の後の子の環境が `CLAUDE_CONFIG_DIR=/Users/konaito/.cam/profiles/agent`。返事は `AGENT-OK` |

ノードのログには、選ぶたびに `account: shared (cam usage best (normal))` が出た。スタブには `sync agent` が渡った。shared の `.claude.json` には `projects["/private/tmp/ccn-acct-test/work"].hasTrustDialogAccepted` が true で入った。

`cam usage --json` は 0.96 秒、`cam sync shared` は 0.36 秒かかった（time で計った）。

`bun test` は 463 件が通り、1 件を飛ばした。`bunx tsc --noEmit -p .` も通った。

## 確かめていないこと

- 本番のノード（jp.fybe.ccn.node）には入れていない
- best が `--default` のコマンドになる場合は、手元に `--default` のコマンドが無いので単体試験だけで確かめた
- 別の機械（cam の無いノード）では動かしていない。cam が無いときは単体試験で、環境を変えないことを確かめた
