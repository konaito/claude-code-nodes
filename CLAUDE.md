# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

Claude Code Nodes（ccn、旧 cc-web）は ccn.fybe.jp の中身。各機械で動くノードが、その機械の Claude Code セッションを HTTP と SSE で開放する。複数のノードを Cloudflare Tunnel と Access でつなぎ、画面（`/`）と CLI の `ccn` から一覧、送信、権限応答、中断、停止を行う。設計の正本は `docs/superpowers/specs/2026-11-06-cc-protocol-design.md` で、作業の前に読む。

## コマンド

```bash
bun install
bun test                                   # 全試験。Cloudflare も claude も使わない
bun test test/relay/relay.test.ts          # 1ファイル
bun test -t "<試験名の一部>"                 # 名前で絞る
bunx tsc --noEmit -p .                     # 型検査。lint は無い
CC_LIVE=1 bun test test/live.test.ts       # 本物の claude を使う試験。VM（orb run -m ubuntu）で回す
CCN_CONFIG=/path/ccn.json bun run src/cli/ccn.ts serve   # 別の設定でノードを立てる（旧の CC_CONFIG も読む）
scripts/smoke.sh <port> [cwd]              # 127.0.0.1 のノードを curl で一通り叩く
scripts/smoke-remote.sh                    # サービストークンで外から叩く
```

`bin/ccn` は `bun run src/cli/cc.ts` を呼ぶだけの sh で、`~/.local/bin/ccn` にリンクして使う。CI は無いので、push の前に `bun test` と `tsc` を手元で回す。

## 全体の形

- どのノードも同じコードで、ノードごとの役割は無い。入口（ccn.fybe.jp）は CNAME が指しているノードで、入口用のコードは無い。
- ノードはデータを保存しない。会話の正本は Claude Code の jsonl（SDK の `listSessions` と `getSessionMessages` だけで読み、直接は解析しない）、仲間の一覧は Cloudflare のトンネル一覧、画面の状態はブラウザの localStorage にある。
- 外側への依存は境界の interface を通す。組み立ては `src/main.ts` の `buildDeps` の1か所だけで、試験は偽物の実装（`test/helpers/`）で通す。

| 境界 | 本物 | 試験用 |
| --- | --- | --- |
| `Driver`（`src/engine/driver.ts`） | `NodeDriver`（SDK の `query()`、ノードが立てた子）、`TerminalDriver`（人が端末で起動したセッションの受信ソケット。send だけ）、`PtyDriver`（`src/engine/pty-driver.ts`、ノードが PTY で動かす対話の claude） | `test/helpers/fake-driver.ts`、`fake-query.ts`、`fake-pty.ts` |
| `Identity`（`src/identity/`） | `AccessIdentity`（Access の JWT を JWKS で検証） | `HeaderIdentity`（loopback のときだけ） |
| `Registry`（`src/registry/`） | `CloudflareRegistry`（`cc-` で始まるトンネル） | `StaticRegistry` |

- API は能力（`capabilities`: send、permissions、interrupt、stop、events、PTY のセッションだけが持つ terminal）を見て振る舞い、セッションの種類で分岐しない。能力に無い操作は `CapabilityError` で 409 になる。境界の例外から状態コードへの変換は `src/api/errors.ts` に集める。
- `src/api/app.ts` は1リクエストに1回 `callerOf` で呼び手を決め、GET と HEAD 以外は全部 CSRF の検査（Origin のホストと sec-fetch-site）を通す。`/n/<peer>/api/...` は `src/relay/relay.ts` がサービストークンと `x-ccn-from`、`x-ccn-via`（移行の間は旧の `x-cc-*` も）を付けて相手のノードへ転送する。認証が要らないのは `/install`、`/install/ccn.tar.gz`（と旧の `/install/cc.tar.gz`）、`/skill.md` だけ。PTY の子の hooks の受け口 `/hooks/pty/<id>` は Access と CSRF の検査を通さず、同じ機械（loopback で `cf-connecting-ip` が無い）からの要求で、セッションごとの token（`x-ccn-hook-token`）が合うものだけを受ける。
- 親子は保存しない。子に届く文の1行目の from 行（`src/identity/from-line.ts`、`from <呼び手> via <ノード>`）から、`History` と `GET /api/sessions?parent=` が導く。
- 子は孫まで（`src/api/depth.ts`）。人が立てたもの（呼び手が email、`local`、sessionId の無い名前）が深さ0、子が1、孫が2で、`Sessions.create` が孫からの作成（HTTP、MCP、CLI の全部）を 409 で断る。深さは作ったときに `Sessions` のメモリに刻み、刻んだ値の無いもの（端末、過去、再起動の前）は呼び手の sessionId の先頭8文字から親をたどる。親は生きている間の呼び手と最初の文の from 行の両方を見て大きいほうを取るので、resume（人の resume も）で深さが戻らない。別のノードのセッションは中継の `GET /api/depth?session=` で聞き、古い版か届かないときは断らない。受け口のセッションは段に数えない。`as_session` を省いた呼び手は人と見分けられないので、暴走止めであって防御ではない。
- `SessionStore` はメモリの台帳で、イベントに seq を振って SSE の購読に配る。1通も届かない待機中のセッション（`awaitingFirst`）は、終わったものと同じく30分で消す。
- エージェントが立てた子（parent が `agent:` の node と pty）は、idle のまま `idleStopMinutes`（設定、既定10分、0 で止めない）を過ぎると台帳が止める（`src/sessions/idle-stop.ts`、#44）。タイマーはセッションごとに1本で、台帳が idle への変化を見たときに張る。発火したら最後の動き（`lastActivityAt` と、pty の端末の画面の接続と切断）からの時間を見て、足りなければ残りで張り直す。端末の画面が開いている間と、`claude agents --json` が busy と言う間は止めない。理由は `exitReason` の `idle-stop:` で、台帳から掃いた後も256件まで覚えて一覧と詳細の過去分に重ねる。MCP の `list_sessions` は、止めてから1日の間は既定の一覧にも出す。端末の SSE が切れたら、`sse` の `onCancel` で購読をすぐ外す。`it.return()` は、次の枠を待って止まっているジェネレーターに次の出力まで届かず、待機中の画面が数え続けられるため。切断に気づくのは次の keep-alive（15秒ごと）を書いたときになる。
- `GET /api/sessions` は `?state=`（`live` か状態のカンマ区切り）で絞れ、`ETag` と 304 を返す。exited を含まない絞り込みでは `listSessions` を読まない。`GET /api/sessions/stream` は一覧の変化を流す SSE で、`src/api/list-watch.ts` にある。購読がある間だけ、台帳の変化をすぐ流し、端末のセッションを4秒ごと（`LIST_TICK_MS`）に取り直して比べる。購読がある間は、要求の側から `claude agents --json` を起動しない。
- `POST /api/sessions` は cwd を省くと受け口（設定の `lobby`、既定は names.ts の `lobbyDirOf`）に立てる。prompt も resume も無ければ、ノードが UUID を決めて SDK の `sessionId` に渡し、1通目の send まで claude を起動しない（`NodeDriver` の遅延起動。待つ claude は1体約300MB）。古い版のノードは `cwd is required` か `prompt or resume is required` で断るので、画面、CLI、MCP はその文言を見て古い版だと伝える。
- `Sessions.create` は claude を起動する前に `trust`（`src/engine/trust.ts`）を呼び、claude が読む `.claude.json`（`CLAUDE_CONFIG_DIR` があればその中、無ければホーム）の `projects[<cwd>]` と `projects[<git のルート>]` の `hasTrustDialogAccepted` を true にする（#46）。無いと PTY の子が信頼の確認画面で止まる。claude と同じロック（`<file>.lock` のディレクトリ）を取り、一時ファイルから rename で書く。読めないとき、ロックが空かないときは書かずに起動を続ける。この項目の形は公開の仕様ではなく、次の決まりの例外である。版を上げたら確認画面が出ないことを確かめる。
- `POST /api/sessions` と MCP の `create_session` は、`terminal: true` で PTY のセッション（`PtyDriver`、kind `pty`）を立てる。`name`（claude の `--name`）、`cols`、`rows` も受け、作成の応答に `kind` を入れる。`NodeDriver` と違い、prompt が無くてもすぐ claude を起動する。`terminal` を知らない古い版のノードは node の子を立てるので、MCP はそれを `note` で返す。
- `PtyDriver` は `Bun.Terminal` で `claude --session-id <id> --settings <file>` を起動する。`Bun.spawn` の `terminal` には、作った `Terminal` ではなく options を渡す。作った `Terminal` を渡すと、claude が PTY を制御端末に持たず、resize の SIGWINCH が届かない（`test/engine/pty-spawn.test.ts`）。承認、ターンの終わり、状態は、`--settings` で注入した hooks から受け、画面の文字は読まない。hooks は途中の文を運ばないので、会話の行は hooks が届くたびに SDK の `getSessionMessages` で読み、まだ流していない assistant の行と道具の結果の行を流す。起動より前の時刻の行（resume で引き継いだ分）は流さない。tool_use の行は PreToolUse の時点で jsonl にあり、tool_result の行は PostToolUse の後に書かれる（#43）。そのため PreToolUse の hook で読み、PostToolUse の後は結果の行が出るまで短い間隔で数回だけ読み直す。読み込みは走っている1本と続く1本にまとめる。承認は PermissionRequest の hook で受ける。hooks は http で、SessionStart だけは curl の command にする。token は 0600 のファイルで渡し、引数に出さない。hooks が届かない操作（端末での承認や拒否、Esc）の後は、`claude agents --json` の `status` と `waitingFor` で状態を合わせる。send は承認待ちの間は `BusyError` で 409 になる。起動直後の send は、SessionStart と、claude が入力を読み始めた印（出力の `ESC[?2004h`）の両方を最大10秒待つ。SessionStart は入力の準備より先に来るので、それだけを待って貼ると Enter が捨てられる（#26）。端末の口の入力も、`ESC[?2004h` が出るまで溜めてから流す。10秒たっても出なければ、溜めた分をそのまま流す。
- PTY のセッションを resume で付け直すとき（ノードの再起動の後など）、`Sessions.create` は claude を起動する前に会話の件数を `History.count` で数え、台帳の seq をその件数（`historyBase`）から振る。`messages?after=` は、after が `historyBase` より前なら jsonl の会話を履歴の位置で返し、読み切ったページには続けて台帳のイベントを入れる。cursor と SSE の seq の数え方は変わらない。作成の応答の `cursor` は `historyBase` で、MCP の `create_session` はそれを返す。fork は 0 のまま。
- 端末の口は `GET /api/sessions/<id>/terminal`（SSE）、`POST …/terminal/input`、`POST …/terminal/resize` の3つで、`src/api/terminal.ts` にある。SSE は `size`（cols、rows、epoch）、`replay`、`data`、`exit` の順に流し、`id` はバイト位置になる。`?after=<位置>&epoch=<epoch>` か Last-Event-ID で続きから読める。中継の `/n/<peer>/api/...` も同じ道を通る。replay は `@xterm/headless` と `@xterm/addon-serialize`（`src/engine/screen.ts`）で取った今の画面のスナップショットで、取れないときは覚えている出力の末尾（既定 2MB）で代える。
- 一覧では、PTY の子が `claude agents --json` にも出る分を除く。id が同じものに加え、端末で `/clear` して id が変わったものも pid で除く。
- 一覧では、裏方の `claude -p`（Stop hook の close-check、launchd のジョブ）も除く。`claude agents --json` は `-p` の実行も kind interactive で返すため。`src/engine/agents.ts` の `withoutHeadless` が pid の制御端末と引数を `ps` で1回に読み、制御端末が無く、引数に `-p` か `--print` があるものを外す。引数だけで判定すると、最初の文を引数で受けた PTY の子が文の中の `-p` に当たって消える。PTY の子の状態合わせ（`agentInfo`）には掛けない。
- ノードが SIGTERM、SIGINT、SIGHUP で止まるとき、`src/main.ts` の `stopPtysOnExit` が PTY の claude を止める。PTY を閉じるだけで claude がすぐ終わるとは限らないため。SIGKILL で落ちたときは `stopPtysOnExit` が動かない。2026-11-12 に macOS で試すと、待機中の claude は2秒以内に終わった。作業中の claude は試していない。ノードを止めると PTY のセッションは全部終わり、会話は `terminal: true` と `resume` で続ける。
- 受け口の CLAUDE.md のひな形は `src/lobby/lobby-claude.md`（このリポジトリで読み込まれないように CLAUDE.md という名前にしない）。`src/lobby/lobby.ts` がノードの起動、`ccn install`、`ccn update` のたびに、CLAUDE.md と `.claude/settings.json`（受け口の許可）を書き出す。settings.json の deny には、roots とホームの下の秘密の置き場（`.ssh`、`.config/ccn` など）と、どこにあっても `.env`、`*.pem`、`*.key` を入れる。settings.json の allow は SDK のセッションでは未信頼として無視されるので、`src/api/sessions.ts` が cwd が受け口のセッションにだけ同じファイルを SDK の `settings` で渡す。起動でも書くのは、初回の `ccn update` を走らせるのが入れ替え前の旧コードだから。受け口は子を `ccn new <dir> <文> --mode <自分のモード> --as lobby` で立てる。MCP で立てると親が `local` になり、受け口の子として並ばない。
- CLI は `src/cli/commands.ts`（セッション操作）と `src/cli/join-commands.ts`（setup、node add/token/remove、entry、install、update、uninstall、doctor、serve）に分かれる。`src/join/` はインストーラ、tar の束、launchd と systemd --user、cf CLI の呼び出しを持つ。
- teleport（`src/teleport/`）はセッションを会話と作業ツリーごと別のノードへ移す。会話は SDK の `importSessionToStore` で読み、移動先では jsonl を `<CLAUDE_CONFIG_DIR>/projects/<cwd の符号>/` に直接書いて `getSessionInfo` で確かめる（SDK に置き場を指定して書く関数が無いため。history.ts の「直接は読まない」は変えない）。作業ツリーは index と作業ツリーを `commit-tree` で写して git bundle で運び、移動先は汚れていれば止める。`reset --hard`、`clean`、`checkout -f`、`git stash` は使わない。移動元のノードが下見、止める、書き出す、取り込むを進める（`POST /api/sessions/:id/teleport`）。手元へ持ってくるときは、端末の claude と同じ設定ディレクトリに書くため CLI のプロセスの中で取り込む（`src/cli/teleport.ts`）。子孫ごと移す `subtree` と計画だけ返す `dryRun` は無く、body に付くと何もせずに 501 で断る。Claude Town の転出が子孫のいるセッションで送るため、無視すると計画のつもりで移してしまう。設計は `docs/superpowers/specs/2026-11-12-session-teleport-design.md`。
- `/mcp` は MCP の口（`src/mcp/`）。公式 SDK（`@modelcontextprotocol/sdk` 1.32.2、agent-sdk の peer と同じ版）の `WebStandardStreamableHTTPServerTransport` を状態なし・JSON 応答で使い、要求ごとに McpServer を作る。ツールは `createApp` の `dispatch`（HTTP の API と中継と同じ道）を、Identity が決めた呼び手のまま呼ぶだけで、from 行も能力の検査も API 側にある。`as` で名乗れるのは、HTTP で `x-ccn-from` を信じてもらえる呼び手（サービストークンと同じ機械）だけ。待つツール（`read_messages`）は最大50秒で返し、cursor で続きを読む。
- `/skill.md` は認証なしで配る説明書。正本は `skills/claude-code-nodes/SKILL.md` で、`{{ORIGIN}}` を要求の入口に置き換える。`skills/ccn/` と違い、利用者の機械にはリンクしない。Bypass アプリは `<host>/install` と `<host>/skill.md`（`PUBLIC_PATHS`）を外す。
- `skills/ccn/` は利用者の機械に配るスキルと child.md の正本。`ccn install` と `ccn update` が `~/.agents/skills/ccn` へリンクし、child.md を `~/.config/ccn/child.md` に置く。

## 決まっていること

- 設定と秘密は `~/.config/ccn/ccn.json`（0600）にまとめる。トンネルトークンは別のファイル。秘密をシェル履歴、ps、リポジトリ、ログに残さない。
- 名前（製品名、CLI 名、置き場、常駐、ヘッダ、配布物、Cloudflare の資源名、localStorage のキー）は `src/names.ts` に集めてあり、変えるときはそこだけを直す。`index.html` とインストーラの文字列も names.ts から差し込み、`bin/ccn` と `scripts/*.sh` との一致は `test/names.test.ts` が確かめる。エージェント名（`agent:<ノード>/<sid8>/<役割>`）の組み立てと分解は `src/identity/agent-name.ts`。
- CLI の名前は `ccn`。macOS には C コンパイラの `/usr/bin/cc` が必ずあり、`cc` にすると `~/.local/bin` にリンクを置けない。
- 2026-11-11 に名前を cc から ccn（製品名 Claude Code Nodes）にそろえた。設定は `~/.config/ccn`、アプリは `~/.local/share/ccn`、常駐は `jp.fybe.ccn.*` と `ccn-*`、トンネルとホスト名は `ccn-<name>`、入口は `ccn.fybe.jp`。旧の名前は `src/names.ts` の `LEGACY_*` にあり、移行の間は新旧の両方を受ける（ヘッダ、配布物のパス、登録簿のトンネル名の頭、設定の置き場）。旧から新へ移すのは `src/join/migrate.ts` で、`ccn update` と `ccn install` が呼ぶ。手順は `docs/runbooks/2026-11-11-ccn-rename.md`。`src/cli/cc.ts` は旧の常駐が呼ぶ入口なので、全部の機械が移るまで残す。`/tmp/cc-socks` は Claude Code 側のパスなので変えない。
- ノードのホスト名は `ccn-<name>.fybe.jp`（1階層。改名前は `cc-<name>.fybe.jp`）。`*.cc.fybe.jp` を覆う証明書はもう無く、ACM も無いので、2階層のホスト名に戻さない。経緯は `docs/results/2026-11-06-application-migration.md`。
- Cloudflare の操作は `cf` CLI で行う。削除とキャッシュの purge は `--force` が無いと非対話で止まる。
- `@anthropic-ai/claude-agent-sdk` は CLI と同じ版（0.3.318）に固定し、`test/smoke.test.ts` が確かめる。
- Claude Code の非公開の内部（jsonl の直接解析、tmux、バイナリの文言）に依存しない。Worker、DB、画面専用の API、複数ユーザーは作らない。
- 試験の結果や本番での確認は `docs/results/` に残す。
