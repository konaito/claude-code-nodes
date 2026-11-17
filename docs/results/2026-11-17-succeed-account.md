# 引き継ぎ（succeed）とアカウント表示の確認結果

2026-11-17。対象はfeat/succeed-account。アカウント名とemailは伏せ、`<A>`と書く。

## 何をしたか

- 単体試験を足した。`bun test`で499件が通り（liveの1件はskip）、`bunx tsc --noEmit -p .`も通った。
- このMacに開発用のノードを別のポート（4391）と別の設定（`CCN_CONFIG`）で立てた。roots と受け口は`/private/tmp/ccn-succeed-dev`の下に置いた。
- 開発用のノードは、本番のノード（launchd）と同じく、`CLAUDE_`で始まる環境変数を持たせずに起動した。
- 試したのは捨てのセッションだけで、モデルはhaiku。同時に動かしたclaudeは3本まで。
- Claude Codeは2.1.326。試した間のload averageは25前後だった（ほかの作業による）。

## 結果

### ptyの引き継ぎ

前任（pty、深さ1、parentは`agent:devnode/aaaaaaaa/meta`）と、その子（pty、深さ2）を立てた。前任に合言葉を覚えさせてから、呼び手を名乗らずに`{resume, fork: true, succeed: true, prompt}`を送った。

| 見たこと | 結果 |
| --- | --- |
| 応答までの時間 | 4.3秒。プロンプト無しの2回目は5.1秒 |
| 後継のid | 新しい（`83980154…`。前任は`bab8f625…`） |
| 前の会話 | 後継は合言葉を答えた |
| 後継のparentとdepth | 前任と同じ（`agent:devnode/aaaaaaaa/meta`、1） |
| 後継のプロセス | `CLAUDE_CONFIG_DIR`は`~/.cam/profiles/<A>`（`cam usage`のbest）。`ps eww`で見た |
| 応答と一覧の`account` | `<A>`。`accountEmail`も載った |
| 子のparent | `agent:devnode/bab8f625/lead`から`agent:devnode/83980154/lead`に変わった |
| 子の知らせ | 子に1通送ると、ターンの終わりの知らせが後継に届いた |
| 前任 | `exited`、`exitReason`は`succeeded: continued as 83980154-…` |
| 前任へのsend | 409で、`successor`に後継のidが入った |

応答（emailは除いた）。

```json
{"id":"83980154-adf1-426d-9932-805c8d4aee66","cwd":"/private/tmp/ccn-succeed-dev/work","state":"running","kind":"pty","depth":1,"cursor":0,"parent":"agent:devnode/aaaaaaaa/meta","account":"<A>","succeeded":{"from":"bab8f625-20c2-4f15-8d3a-a6f5241049c9","stopped":true,"adopted":["58f03798-6c75-4c0a-a81f-aed5dfae042f"]}}
```

後継に届いた知らせ。

```
from ccn:devnode/58f03798 via devnode

[ccn] 子 捨ての子（58f03798）のターンが終わった。read_messages peer=devnode session=58f03798-6c75-4c0a-a81f-aed5dfae042f after=3 で読んで（読み済みなら返事は不要）
```

ノードのログ。

```
succeed: bab8f625-20c2-4f15-8d3a-a6f5241049c9 -> 83980154-adf1-426d-9932-805c8d4aee66 (parent agent:devnode/aaaaaaaa/meta, depth 1, adopted 58f03798-6c75-4c0a-a81f-aed5dfae042f, stopped true)
```

後継をプロンプト無しでもう一度引き継ぐと、次の後継も同じparentとdepthになり、子はその後継に移った。権限モード、モデル、`name`は前任から継がれた。

### nodeの引き継ぎ

前任（node）に合言葉を覚えさせ、`terminal`を省いて引き継いだ。

- 応答は1.0秒で返った。後継は`kind: node`、`state: idle`で、claudeは起動していない。
- `cursor`は3だった。写した会話の件数になる。
- 作成の応答に`account`は無く、1通目を送った後の詳細に載った。
- 後継に1通送ると、合言葉を答えた。

### アカウントの取り直し

ノードを起動し直してから、履歴だけの前任2つを続けて引き継いだ。2回で1.9秒だった。ログの`account:`の行は2行増えた。30秒の使い回しの中でも、引き継ぎのたびに`cam usage`を取り直している。

この確認では、後継のアカウントは前任と同じ`<A>`だった。前任は上限に達していなかったので、bestが変わらなかった。

### 同じ前任の2回目

同じ前任をもう一度引き継ぐと、409で`code: already_succeeded`と後継のidが返った。

### 端末のセッションのアカウント

開発用のノードから見ると、本番のノードが立てたptyのセッションは端末のセッションになる。その15件すべてで、一覧に`account`と`accountEmail`が載った。

Linuxでは、OrbStackのUbuntu（procps-ng 4.0.4）で`sleep`のプロセスに対して同じ読み方を試し、`CLAUDE_CONFIG_DIR`が読めた。claudeのプロセスでは試していない。

## 分かったこと

- forkした会話の最初の文は、前任の最初の文と同じだった（SDKの`getSessionInfo`の`firstPrompt`）。ノードを起動し直すと、後継のparentは前任の最初の親になる。
- ptyのforkは、後継に1通目が届くまでjsonlが無かった。それより前にノードが止まると、後継は履歴に残らない。前任の会話は残る。
- ノードを起動し直すと、付け替えた子のparentは前任の名前（`agent:devnode/bab8f625/lead`）に戻った。付け替えはメモリだけにあるため。
- 履歴だけの前任を、呼び手を名乗らずに引き継ぐと、後継のparentは履歴のparentになった。`local`にはならなかった。
- 開発用のノードの捨てのセッションは、本番のノードの一覧に端末のセッションとして見えた。`claude agents --json`が機械の全部のclaudeを返すため。

## 要約から再開するかの確認画面

2.1.326のバイナリには「Resume this conversation?」の確認がある。resumeで会話を読み込んだときに出す作りになっている。文字列から読めた条件は次の4つ。

- 機能のフラグが入っている。
- 設定の`resumeReturnDismissed`が立っていない。確認の「今後は聞かない」を選ぶと立つ。
- 最後の文から70分以上たっている。
- 会話が10万トークン以上ある。

捨ての会話で、しきい値の環境変数（`CLAUDE_CODE_RESUME_THRESHOLD_MINUTES`と`CLAUDE_CODE_RESUME_TOKEN_THRESHOLD`）を0分と1トークンに下げて試した。resumeの直後にも、1通送った後にも、確認は出なかった。フラグが切られているのか、環境変数が効いていないのかは見分けられなかった。

起動の印（SessionStartのhook）は、どちらの場合もresumeから0.8秒で届いた。

確認が出たときの扱いは次のとおりに決めた。

- ノードは確認に答えない。画面の文字を読まない決まりのため。
- 起動の印より前に確認が出るなら、引き継ぎは502（`successor_failed`）で止まり、前任と子は変わらない。
- 起動の印より後に確認が出るなら、引き継ぎは済み、後継の端末に確認が残る。人が端末の画面で選ぶ。「今後は聞かない」を選べば、そのアカウントでは次から出ない。
- nodeの後継（`terminal: false`）は対話の画面を持たないので、この確認は出ない。

## 確かめていないこと

- 利用上限で止まったptyの`state`。引き継ぎは前任の`state`で断らないので、動きには関わらない。
- 大きくて古い本物の会話での引き継ぎ。上の確認画面が出るかどうかを含む。
- launchdの下のノードから`ps eww`でほかのプロセスの環境が読めるか。開発用のノードは端末のシェルから起動した。
- 枠の残るアカウントが無いときの実地の動き。単体試験では確かめた。
