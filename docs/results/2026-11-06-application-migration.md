# 移行の記録（Task 15）

2026-11-06。本人の承認を取りながら1段ずつ進める。

## Step 1: incertotechを足す

- Macで`cc node add incertotech --port 4323 --to <0600のファイル>`。トンネル`cc-incertotech`（d21a0fd0…）、CNAME `incertotech.cc.fybe.jp`。旧ノードが4321と4322を使っているので4323にした。
- 参加トークンはsshの標準入力で`/tmp/cc-join.token`（umask 077）に写し、incertotechで`sh -c "$(curl -fsSL https://vm.cc.fybe.jp/install)" < /tmp/cc-join.token`を実行し、終わったら両方のファイルを消した。
- インストーラはbun 1.3.14で102パッケージを入れ、LaunchAgent `jp.fybe.cc.node`と`jp.fybe.cc.tunnel`を入れた。doctorは起動直後に「手元のAPI」と「外からのAPI（530）」がngで、8秒後にやり直すと全部okだった。
- `cf tunnels list`で`cc-incertotech`、`cc-konaito-pro`、`cc-vm`がhealthy。Macの`cc peers`に3台、`cc ls --peer incertotech`でincertotechの端末セッションが読めた。
- incertotechの`~/.config/session-inbox/child.md`は新しい版になり、旧は`child.md.old-20261106-1328`に退避した。旧ノード（4321、4322）は動いたまま。
