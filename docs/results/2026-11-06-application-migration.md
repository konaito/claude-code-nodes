# 移行の記録（Task 15）

2026-11-06。本人の承認を取りながら1段ずつ進める。

## Step 1: incertotechを足す

- Macで`cc node add incertotech --port 4323 --to <0600のファイル>`。トンネル`cc-incertotech`（d21a0fd0…）、CNAME `incertotech.cc.fybe.jp`。旧ノードが4321と4322を使っているので4323にした。
- 参加トークンはsshの標準入力で`/tmp/cc-join.token`（umask 077）に写し、incertotechで`sh -c "$(curl -fsSL https://vm.cc.fybe.jp/install)" < /tmp/cc-join.token`を実行し、終わったら両方のファイルを消した。
- インストーラはbun 1.3.14で102パッケージを入れ、LaunchAgent `jp.fybe.cc.node`と`jp.fybe.cc.tunnel`を入れた。doctorは起動直後に「手元のAPI」と「外からのAPI（530）」がngで、8秒後にやり直すと全部okだった。
- `cf tunnels list`で`cc-incertotech`、`cc-konaito-pro`、`cc-vm`がhealthy。Macの`cc peers`に3台、`cc ls --peer incertotech`でincertotechの端末セッションが読めた。
- incertotechの`~/.config/session-inbox/child.md`は新しい版になり、旧は`child.md.old-20261106-1328`に退避した。旧ノード（4321、4322）は動いたまま。

## Step 2〜4（本人の「やって」、2026-11-06）

- 旧の常駐を止めた。Macとincertotechの`com.konaito.session-inbox`と`-tunnel`をbootoutし、plistは`~/.config/session-inbox/migration-backup-20261106/launchagents/`に退避した。4321と4322の待ち受けは両方の機械で無くなった。
- 旧Cloudflareを消した。消す前に、Accessアプリ2つ、サービストークン一覧、DNS、トンネル一覧、親用の再利用ポリシーを`~/.config/session-inbox/migration-backup-20261106/`（0700、各0600）に控えた。
  - 消したもの: Worker `session-inbox-hub`、Accessアプリ`session-inbox`と`session-inbox-nodes`、再利用ポリシー`session-inbox parent agent`（親用トークンが使われていて先に消す必要があった）、サービストークン3つ、DNS `cc-node-pro`と`cc-node-incerto`、トンネル`session-inbox`と`session-inbox-incerto`。
  - `cc.fybe.jp`のAAAAは、Workerを消した時点でカスタムドメインと一緒に消えていた。
  - cfの削除は確認を求めて非対話では止まるので`--force`を付けた。`cc node remove`と`cc entry`の中の削除にも付けた（e495ff9）。
- `cc setup --hosts '*.cc.fybe.jp,cc.fybe.jp'`でAccessアプリ`cc`と`cc-install`に`cc.fybe.jp`を足し、`cc entry incertotech --port 4323`でingressとCNAMEをincertotechに向けた。3台の設定から仮の入口（vm）を消した。
- `https://cc.fybe.jp/`は認証無しでAccessへ302、`/install`は公開で200（`ENTRY="https://cc.fybe.jp"`）、サービストークンで`/api/host`がincertotech、`/api/peers`が3台healthyを返した。Macの`cc update`は`https://cc.fybe.jp/install/cc.tar.gz`から通った。

## 起きたこと: `*.cc.fybe.jp` の証明書が消えた

- 何が起きた: `cc.fybe.jp/n/vm/...`の中継が502になった。incertotechからもこのMacからも、`vm.cc.fybe.jp`、`konaito-pro.cc.fybe.jp`、`incertotech.cc.fybe.jp`へのTLSがSNIの段で`alert 40 handshake failure`になる。`cc.fybe.jp`、`fybe.jp`、他の1階層のサブドメインは通る。
- 原因: `fybe.jp, cc.fybe.jp, *.cc.fybe.jp`のAdvanced証明書パックが無くなっていた。このアカウントにはAdvanced Certificate Managerが無く（`quota advanced allocated 0`、作ろうとすると`[1450] … available with the Advanced Certificate Manager`）、一覧にある他のAdvancedパック（x-game、bridge、jiku、note、contextcap、jpyc-hensachi）はどれもWorkerのカスタムドメインに付いて自動で出たもの。`*.cc.fybe.jp`のパックも旧Worker `session-inbox-hub`のカスタムドメイン`cc.fybe.jp`に付いていて、Workerを消したときに一緒に消えた。設計書の「Advanced証明書パックが既にあり有効」は、この依存を見ていなかった。
- 影響: `cc.fybe.jp`（Universalの`*.fybe.jp`で覆われる）と入口のincertotechのセッションは使える。各ノードのホスト名（`<name>.cc.fybe.jp`）は全部TLSで弾かれるので、中継、CLIの相手ノード呼び出し、`cc doctor`の外からのAPIが失敗する。
