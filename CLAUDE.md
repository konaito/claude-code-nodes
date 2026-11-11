# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

cc-web は cc.fybe.jp の中身。各機械で動くノードが、その機械の Claude Code セッションを HTTP と SSE で開放する。複数のノードを Cloudflare Tunnel と Access でつなぎ、画面（`/`）と CLI の `ccn` から一覧、送信、権限応答、中断、停止を行う。設計の正本は `docs/superpowers/specs/2026-11-06-cc-protocol-design.md` で、作業の前に読む。

## コマンド

```bash
bun install
bun test                                   # 全試験。Cloudflare も claude も使わない
bun test test/relay/relay.test.ts          # 1ファイル
bun test -t "<試験名の一部>"                 # 名前で絞る
bunx tsc --noEmit -p .                     # 型検査。lint は無い
CC_LIVE=1 bun test test/live.test.ts       # 本物の claude を使う試験。VM（orb run -m ubuntu）で回す
CC_CONFIG=/path/cc.json bun run src/cli/cc.ts serve   # 別の設定でノードを立てる
scripts/smoke.sh <port> [cwd]              # 127.0.0.1 のノードを curl で一通り叩く
scripts/smoke-remote.sh                    # サービストークンで外から叩く
```

`bin/ccn` は `bun run src/cli/cc.ts` を呼ぶだけの sh で、`~/.local/bin/ccn` にリンクして使う。CI は無いので、push の前に `bun test` と `tsc` を手元で回す。

## 全体の形

- どのノードも同じコードで、ノードごとの役割は無い。入口（cc.fybe.jp）は CNAME が指しているノードで、入口用のコードは無い。
- ノードはデータを保存しない。会話の正本は Claude Code の jsonl（SDK の `listSessions` と `getSessionMessages` だけで読み、直接は解析しない）、仲間の一覧は Cloudflare のトンネル一覧、画面の状態はブラウザの localStorage にある。
- 外側への依存は境界の interface を通す。組み立ては `src/main.ts` の `buildDeps` の1か所だけで、試験は偽物の実装（`test/helpers/`）で通す。

| 境界 | 本物 | 試験用 |
| --- | --- | --- |
| `Driver`（`src/engine/driver.ts`） | `NodeDriver`（SDK の `query()`、ノードが立てた子）、`TerminalDriver`（人が端末で起動したセッションの受信ソケット。send だけ） | `test/helpers/fake-driver.ts`、`fake-query.ts` |
| `Identity`（`src/identity/`） | `AccessIdentity`（Access の JWT を JWKS で検証） | `HeaderIdentity`（loopback のときだけ） |
| `Registry`（`src/registry/`） | `CloudflareRegistry`（`cc-` で始まるトンネル） | `StaticRegistry` |

- API は能力（`capabilities`: send、permissions、interrupt、stop、events）を見て振る舞い、セッションの種類で分岐しない。能力に無い操作は `CapabilityError` で 409 になる。境界の例外から状態コードへの変換は `src/api/errors.ts` に集める。
- `src/api/app.ts` は1リクエストに1回 `callerOf` で呼び手を決め、GET と HEAD 以外は全部 CSRF の検査（Origin のホストと sec-fetch-site）を通す。`/n/<peer>/api/...` は `src/relay/relay.ts` がサービストークンと `x-cc-from`、`x-cc-via` を付けて相手のノードへ転送する。認証が要らないのは `/install` と `/install/cc.tar.gz` だけ。
- 親子は保存しない。子に届く文の1行目の from 行（`src/identity/from-line.ts`、`from <呼び手> via <ノード>`）から、`History` と `GET /api/sessions?parent=` が導く。
- `SessionStore` はメモリの台帳で、イベントに seq を振って SSE の購読に配る。
- CLI は `src/cli/commands.ts`（セッション操作）と `src/cli/join-commands.ts`（setup、node add/token/remove、entry、install、update、uninstall、doctor、serve）に分かれる。`src/join/` はインストーラ、tar の束、launchd と systemd --user、cf CLI の呼び出しを持つ。
- `skills/session-inbox/` は利用者の機械に配るスキルと child.md の正本。`ccn install` が `~/.agents/skills/session-inbox` へリンクする。

## 決まっていること

- 設定と秘密は `~/.config/cc/cc.json`（0600）にまとめる。トンネルトークンは別のファイル。秘密をシェル履歴、ps、リポジトリ、ログに残さない。
- 名前（製品名、CLI 名、置き場、常駐、ヘッダ、配布物、Cloudflare の資源名、localStorage のキー）は `src/names.ts` に集めてあり、変えるときはそこだけを直す。`index.html` とインストーラの文字列も names.ts から差し込み、`bin/ccn` と `scripts/*.sh` との一致は `test/names.test.ts` が確かめる。エージェント名（`agent:<ノード>/<sid8>/<役割>`）の組み立てと分解は `src/identity/agent-name.ts`。
- CLI の名前は `ccn`。macOS には C コンパイラの `/usr/bin/cc` が必ずあり、`cc` にすると `~/.local/bin` にリンクを置けない。設定とアプリの置き場（`~/.config/cc`、`~/.local/share/cc`）は改名前のまま。
- ノードのホスト名は `cc-<name>.fybe.jp`（1階層）。`*.cc.fybe.jp` を覆う証明書はもう無く、ACM も無いので、2階層のホスト名に戻さない。経緯は `docs/results/2026-11-06-application-migration.md`。
- Cloudflare の操作は `cf` CLI で行う。削除とキャッシュの purge は `--force` が無いと非対話で止まる。
- `@anthropic-ai/claude-agent-sdk` は CLI と同じ版（0.3.318）に固定し、`test/smoke.test.ts` が確かめる。
- Claude Code の非公開の内部（jsonl の直接解析、tmux、バイナリの文言）に依存しない。Worker、DB、画面専用の API、複数ユーザーは作らない。
- 試験の結果や本番での確認は `docs/results/` に残す。
