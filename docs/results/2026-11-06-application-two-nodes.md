# 試作4の結果（2台目の参加、中継、親子）

2026-11-06。対象はcc-webのfeat/application（Task 13）。前段は`docs/results/2026-11-06-application-vm.md`。

## 親子（VMの上で、自分のノードに対して）

MacのリゾルバがDNSの負のキャッシュを持っていた間に、VMで`cc`を自分のノードに向けて通した（`CLAUDE_CODE_SESSION_ID=deadbeef-…`を親のidとして与えた）。

| 命令 | 結果 |
| --- | --- |
| `cc peers` | `konaito-pro inactive`、`vm healthy (self)` |
| `cc new ~/work "Reply with the single word ready, then wait." --as lead --mode default` | `vm/273d6abb-…` |
| `cc read <対象> --wait 60` | `ready`、`state=idle pending=0 seq=11` |
| `cc run <対象> "Use the Write tool to create cli.txt …"` | `[tool] Write /home/konaito/work/cli.txt`、`[permission] Write … requestId=e8b96a5a-…`、`state=waiting_permission pending=1 seq=26`（終了コード3） |
| `cc show <対象>` | `state: waiting_permission`、`permissionMode: default`、`parent: agent:vm/deadbeef/lead`、`pending: e8b96a5a-… Write /home/konaito/work/cli.txt` |
| `cc allow <対象>` | `allow e8b96a5a-…`（pendingが1件なのでrequestIdを省けた） |
| `cc read <対象>` | `I created /home/konaito/work/cli.txt containing exactly hi.`、`state=idle pending=0 seq=40`。ファイルは2バイトでできていた |
| `cc ls --mine` | `vm/273d6abb node idle /home/konaito/work agent:vm/deadbeef/lead`の1行 |
| `cc stop <対象>` | 止まった |

直したこと。
- `bin/cc`が`~/.local/bin/cc`のsymlinkから呼ばれると`$0`のdirnameで実体を見失っていた。symlinkをたどるようにし、試験を足した。
- `cc ls`は落ちている相手（inactive、down）を呼ばず`<peer>  (inactive)`の1行にし、JSONでない誤り（Cloudflareの530のページ）はタグを落として60文字に縮めた。

## 2台目（Mac konaito-pro）の参加（公開インストーラ）

- Macで`cc node add konaito-pro --port 4323`（トンネル`cc-konaito-pro` 850416db…、CNAME `konaito-pro.cc.fybe.jp`）。
- クリップボードが別の内容に2回上書きされたので、`cc node token <名> --to <0600のファイル>`を足し、`sh -c "$(curl -fsSL https://vm.cc.fybe.jp/install)" < <ファイル>`で入れた。`/install`はAccess無しで200（Bypassアプリ`*.cc.fybe.jp/install`が効いた。仕様の確認事項9の答え）。
- 最初の実行はインストーラの`read -r`が、末尾に改行の無い入力でEOFの非ゼロを返し`set -e`で黙って止まっていた。`IFS= read -r TOKEN || :`に直し、試験を足した。
- 入ったもの。`~/.local/share/cc/app`（VMの配布物から、`bun install --production`で102パッケージ）、`~/.config/cc/cc.json`（name konaito-pro、port 4323、entry vm）と`tunnel.token`、LaunchAgent `jp.fybe.cc.node`と`jp.fybe.cc.tunnel`（running）、`~/.agents/skills/session-inbox`はappへのsymlink（旧はsession-inbox.old-20261106-0559に退避）、`~/.config/session-inbox/child.md`は複製（旧は.old）。`/usr/bin/cc`があるので`~/.local/bin/cc`は置かず案内だけ出た。
- doctorは全部ok。ただし「外からのAPI」は530でもokと出ていた（判定の誤り。直して試験を足した）。530はトンネルが繋がる前の一瞬で、直後の確認では`cf tunnels list`で`cc-konaito-pro`がhealthy、サービストークンで`https://konaito-pro.cc.fybe.jp/api/host`が200。
- 旧ノード（127.0.0.1:4322、com.konaito.session-inbox）は動いたまま。

## 登録簿と中継（外から、サービストークン）

| 要求 | 結果 |
| --- | --- |
| `GET https://vm.cc.fybe.jp/api/peers` | konaito-pro healthy、vm healthy (self) |
| `GET https://vm.cc.fybe.jp/n/konaito-pro/api/sessions` | Macの端末セッション100件（kind terminal） |
| `GET https://vm.cc.fybe.jp/n/konaito-pro/api/host` | name konaito-pro |
| `GET https://konaito-pro.cc.fybe.jp/n/vm/api/host`（逆向き） | name vm。どのノードも入口になれる |
| `GET https://vm.cc.fybe.jp/n/nope/api/host` | 404 |
| `GET https://konaito-pro.cc.fybe.jp/n/vm/api/sessions/<id>/events?after=0` | SSEが流れた（`id: 1`、`event: system`、init…）。中継はストリームをそのまま通す |

## 親子（Macの端末からVMの子へ）

`CLAUDE_CODE_SESSION_ID`はこの作業のセッション（2db6499a…）。

| 命令 | 結果 |
| --- | --- |
| `cc new /home/konaito/work "Reply with the single word ready, then wait." --peer vm --as lead --mode default` | `vm/35d67497-…` |
| `cc read` | `ready`、`state=idle pending=0 seq=11` |
| `cc run … "Use the Write tool to create parent.txt …"` | `[permission] Write /home/konaito/work/parent.txt`、終了コード3 |
| `cc show` | `state: waiting_permission`、`parent: agent:konaito-pro/2db6499a/lead` |
| `cc allow` | 通った。`cc read`で`I created … containing exactly from-mac.`。VMに`~/work/parent.txt`（from-mac） |
| `cc ls --mine` | 全ノードを並列に読み、`vm/35d67497 … agent:konaito-pro/2db6499a/lead`の1行 |
| `cc stop` | 止まった |

VMから`cc ls --peer konaito-pro`で、Macの端末セッション（この作業のcc-web-6cを含む）が読めた。

## cc update（Macで、入口はVM）

VMの実行物を最新のcheckoutに揃えてcc-nodeを再起動したあと、Macで`~/.local/share/cc/app/bin/cc update`を実行した。`https://vm.cc.fybe.jp/install/cc.tar.gz`を`app.new`に展開し、`bun install --production`、`app`と入れ替え、LaunchAgentのnodeを`launchctl kickstart -k`で再起動した。nodeのpidが90565から91982に変わり、`/api/host`が200、`app.new`と`app.old`は残っていない。
