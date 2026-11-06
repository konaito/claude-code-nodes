# プロトコル（第1部）の疎通結果

2026-11-06。対象はcc-webのfeat/protocol（Task 0〜10）。設計はdocs/superpowers/specs/2026-11-06-cc-protocol-design.md、計画はdocs/superpowers/plans/2026-11-06-cc-protocol.md。

## 何をしたか

- 単体試験は偽物のquery、偽のDriver、一時ソケットで通した。`bun test`で42件が通り、liveの1件は`CC_LIVE=1`のときだけ動く。
- live試験をOrbStackのUbuntu VM（Claude Code 2.1.318、agent@fybe.jpのOAuth、bun 1.4.4）で回した。
- VMでノードを立て、`scripts/smoke.sh`をcurlで一通り通した。
- このMacでノードを別ポート（4399）で立て、端末セッションの一覧と、端末セッション（この作業をしていたClaude Code自身）への注入を確かめた。

## 結果

### live試験（VM、`CC_LIVE=1 bun test test/live.test.ts`）

1件が8.2秒で通った。順に、作成（201）、SSEで`result`（success）、Writeを頼む文を送信、`permission_request`が届き`GET /api/sessions/:id`のstateが`waiting_permission`でpendingが1件、allowで答えると`x.txt`が`hello`で作られた。長い出力の途中で`interrupt`を送ると`result`のsubtypeは`error_during_execution`だった。`DELETE`の後に`resume`で同じidを渡すと同じidのまま続き、前に作ったファイル名を答えた。

```
session f1342404-58a5-42e6-9d61-f49732e56abc
permission for Write
after interrupt: error_during_execution
resumed as f1342404-58a5-42e6-9d61-f49732e56abc (same id)
```

### curlの疎通（VM、`scripts/smoke.sh 4322 ~/work/smoke2`、15.6秒）

- `GET /api/host`はname ubuntu、claude 2.1.318、account agent@fybe.jpを返した。
- `POST /api/sessions`は201でidを返し、`GET .../events`に`event: result`が流れた。
- `GET /api/sessions`はnode idleの1件（parentはlocal）と、過去の2件（state exited、parent無し）を出した。
- `POST .../messages`は`{"delivered":"stdin"}`、`GET .../messages?after=0`は11イベント、`DELETE`は204。
- `curl: (23) client returned ERROR on write`は`grep -m1`がパイプを閉じたために出るもので、ノードのエラーではない。

### 端末セッションへの注入（Mac、ポート4399）

- `GET /api/sessions`にkind terminalが3件出た。pidとcwdは`claude agents --json`と一致した。
- この文書を書いているセッション（6a296a1a…、pid 29375）に`POST .../messages`（`x-cc-from: ceo@fybe.jp`）を送ると`{"delivered":"socket"}`が返り、そのセッションに「別セッションからのメッセージ」として次の文が届いた。

```
from ceo@fybe.jp via konaito-pro

[cc-web Task 10 疎通テスト] 新しいノードの API から端末セッションへ注入した。返事は不要。
```

- 端末セッションへの`POST .../permissions/:id`と`DELETE`は409だった（能力が無い）。
- 過去のセッションはSDKの`listSessions`から97件が出た。

## 分かったこと

- `-p`のstreaming入力でも`system/init`は起動直後に出る。`resume`のときも初回のpromptを渡せばinitが来た。start()の15秒待ちは今回は使われなかった。
- `resume`は同じsession idを続ける（2.1.318）。forkしなければidは変わらない。
- 端末セッションへの注入は、Macでは`/tmp/cc-socks/<pid>.sock`に届いた。VMには端末セッションが無いので未確認。
- SDKはMacで`bun install`したnode_modulesのままVM（Linux）で動いた。`pathToClaudeCodeExecutable`にPATHのclaudeを渡しているので、同梱のdarwin用バイナリは使っていない。

## 残っていること

- 第2部（Access、登録簿、中継、参加、画面）は別の計画。
- 端末セッションの注入で、受信側がbypassかつ`crossSessionInbound`未設定のときの保留の挙動は、このMacではaccept済みなので試していない。
