# 試作3の結果（VMをトンネルとAccessで外に出す）

2026-11-06。対象はcc-webのfeat/application（Task 12）。設計は`docs/superpowers/specs/2026-11-06-cc-protocol-design.md`、計画は`docs/superpowers/plans/2026-11-06-cc-application.md`。

## 何をしたか

1. 本人がダッシュボードでCF APIトークンを作り、Macで`bun run src/cli/cc.ts setup --hosts '*.cc.fybe.jp' --name konaito-pro --port 4323`を実行した（/dev/ttyで貼った）。
2. Macで`bun run src/cli/cc.ts node add vm`を実行した。
3. 参加トークンをクリップボードからVMへ渡し、共有パスの checkout から入れた（`pbpaste | orb run -m ubuntu bash -lc '... cc install --from /Users/konaito/Documents/cc-web'`）。
4. Macから`RESOLVE=<ip> scripts/smoke-remote.sh vm.cc.fybe.jp /home/konaito/work/smoke3`を実行した。

## 結果

### setup（cfで確認）

- Accessアプリ`cc`（id 61d8815d…、`*.cc.fybe.jp`、720h、方針はowner allowとnodes non_identity）。
- Bypassアプリ`cc-install`（id 33d6aa9e…、`*.cc.fybe.jp/install`、bypass everyone）。ワイルドカードとパスの組み合わせはAPIが受け付けた。
- サービストークン`cc-node`（id 93a18915…、期限2027-11-05）。
- 既存のsession-inbox、session-inbox-nodes、session-inbox-*のトークンは変わっていない（listで前後を比べた）。
- `~/.config/cc/cc.json`は0600。試作中の入口として`entry`を`https://vm.cc.fybe.jp`に手で入れた（移行後は消して既定の`https://cc.fybe.jp`にする）。

### node add vm（cfで確認）

- トンネル`cc-vm`（cc836cc6…、remote managed）。ingressは`vm.cc.fybe.jp`から`http://127.0.0.1:4322`。
- DNSに`vm.cc.fybe.jp`のCNAME（`<tunnel id>.cfargotunnel.com`、proxied）。
- 参加トークンはクリップボードに入り、標準出力には出なかった（1047文字）。

### install（VM、Ubuntu 26.04、aarch64）

- 1回目は常駐の組み立てで落ちた（`cc.ts`がserviceManagerにrunnerを渡していなかった）。直して2回目で通った。
- `~/.config/cc/cc.json`と`tunnel.token`（0600）、`~/.local/share/cc/app`（配布物の範囲だけ、`bun install --production`）、`~/.claude/settings.json`にcrossSessionInbound、スキルのリンク2つ、`~/.local/bin/cc`。
- systemd --userの`cc-node`と`cc-tunnel`がactive。`cf tunnels list`で`cc-vm`がhealthy。
- doctorは全部ok（claude 2.1.318、agents --json、常駐2つ、手元のAPI、外からのAPI、claudeのセッション）。
- cloudflaredはインストーラを通さなかったので、先に公式リリースのバイナリ（2026.10.7、linux-arm64）を`~/.local/bin`に置いた。

### 外からの疎通（Macから、30秒）

| 項目 | 結果 |
| --- | --- |
| 認証無しの`GET /api/host` | 302でAccessのログイン画面へ（`fybejp.cloudflareaccess.com/cdn-cgi/access/login/vm.cc.fybe.jp`） |
| サービストークンで`GET /api/host` | 200。name vm、claude 2.1.318、account agent@fybe.jp、rateLimit付き |
| `GET /api/peers` | 502。VMのcc.jsonのcfApiTokenがトークンの形でなく（108文字、空白を含む）、CF APIが400を返した。setupで貼ったものがトークンでなかった。本人に取り直しを頼んだ |
| `POST /api/sessions`（x-cc-from agent:smoke） | 201。一覧にparent agent:smokeで出た |
| SSE | `event: result`が流れた |
| `POST .../messages`（Writeを頼む） | `{"delivered":"stdin"}`。`event: permission_request`が流れ、pendingに1件 |
| `POST .../permissions/:id` allow | `{"ok":true}`のあと`event: result` |
| interrupt、DELETE | `{"ok":true}`、204 |

`curl: (56) Failure writing output`は`grep -m1`がパイプを閉じたために出るもので、ノードのエラーではない。

### 分かったこと

- Macのローカルの名前解決は、CNAMEを作ってから数分は`vm.cc.fybe.jp`を引けなかった（1.1.1.1は引けた）。試験は`curl --resolve`で進めた。
- トンネル越しのノードはhttpで受けるので、CSRFのOrigin検査はschemeでなくhostで比べる必要があった（試作前に直した）。
- Cloudflare経由の要求はJWT無しだと401で断る規則が、Access無しのホスト名を守る（単体試験）。実機では302がAccessの手前で返るので、ノードまで届かない。
