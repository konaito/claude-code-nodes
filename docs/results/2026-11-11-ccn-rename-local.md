# ccn への改名を手元のノードで確かめた（2026-11-11）

PR3（ccn への改名）のコードで、試験用のノードを手元に立てて確かめた。Cloudflare、常駐、ほかの機械には触っていない。

## したこと

- 一時ディレクトリに `ccn.json`（name rename-test、port 4390）を作り、`CCN_CONFIG=<その ccn.json> bun run src/cli/ccn.ts serve` で立てた。手元で動いている 4323 のノードには触っていない。
- curl と agent-browser で次を確かめ、終わったら 4390 のノードを止めた。

## 結果

| 確かめたこと | 方法 | 結果 |
| --- | --- | --- |
| 画面のタイトルと見出し | agent-browser の eval | どちらも Claude Code Nodes |
| localStorage の移し替え | `cc.peer` と `cc.draft.abc` を入れて再読み込み | `ccn.peer`、`ccn.draft.abc`、`ccn.migrated` だけが残り、値は同じ |
| 配布物の新旧のパス | curl | `/install/ccn.tar.gz` と `/install/cc.tar.gz` がどちらも 200、application/gzip |
| 束の中身 | `tar tz` | `src/cli/ccn.ts`、旧の入口 `src/cli/cc.ts`、`skills/ccn/`、`bin/ccn` がある |
| インストーラ | curl `/install` | `TARBALL=.../install/ccn.tar.gz`、`APP="$HOME/.local/share/ccn/app"`、`bun run src/cli/ccn.ts install` |

## 分かったこと

- 最初の起動は `Failed to start server. Is port 4323 in use?` で止まった。`ccn serve` が `CC_CONFIG` と `CCN_CONFIG` を見ず、本物の `~/.config/cc/cc.json` を読んでいた。改名の前のコードも同じで、CLAUDE.md の `CC_CONFIG=... serve` は動いていなかった。PR3 で、環境変数で渡した設定ファイルを参加側の命令（serve、doctor、update など）も読むように直した。4323 のノードは bind に失敗しただけで、止まっていない。
- 見出しの Claude Code Nodes は、左の列（幅 240px）では2行に折り返す。1行に収めるには 13px より小さくする必要があるので、折り返しのままにした。
