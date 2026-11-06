# 画面の目視の結果（Task 14）

2026-11-06。本人のChrome（Claude in Chrome）で`https://vm.cc.fybe.jp/`を開いた。Accessのセッションが残っていたのでログイン画面は出なかった。

## 見たこと

- 3段。左にkonaito-proとvm（healthy、claudeの版、アカウント、動いている数、負荷）。vmに「ここ」の札。中にvmのセッション（動いているものと過去10件）。右に会話。
- 「新しく」→ peer vm、`~/work`、最初の文、default → 立てる。会話が開き、自分の文（あなた）、Claudeの`ready`、`success · 2.8s · $0.077`の順に出た。見出しに`vm · ~/work · node · claude-sonnet-5-5 · default · ceo@fybe.jp`。
- Writeを頼む文を送ると、ツールの行`Write /home/konaito/work/web.txt`と、朱色の枠の「承認を待っている」の札（入力のJSON、許可、拒否）が出て、状態が「承認待ち」になった。許可を押すと結果（File created successfully…）とClaudeの文、`success`の行。VMに`~/work/web.txt`ができた。
- 1〜400を数えさせて「中断」を押すと、`[Request interrupted by user]`と`error_during_execution · 3.1s`が出て状態が「待機」に戻った。
- 「停止」は1回目で朱色の「本当に止める」になり、2回目で止まった。「続きから」は入力欄の文を最初の文にして同じidで再開し、`web.txt`と答えた。
- 偽の`x-cc-from: agent:evil`を付けてブラウザから`POST /n/vm/api/sessions`しても、parentは`ceo@fybe.jp`だった（AccessIdentityがemailのJWTのときヘッダを捨てる）。

## 見つけて直したこと

- 最初にノードのparentが`local`と出て、`main.ts`がAccessIdentityを組み立てていない欠落が分かった。直して両ノードに入れ直した（`test/main.test.ts`）。試作3と4の外からの疎通は、Accessの縁の302は効いていたが、ノード側のJWT検証は無しで通っていた。
- 会話が空のときの「まだ何も無い」の札が、SSEで最初の1件が来ても残っていた。消すようにした。
- ノードが立てたセッションは自分の文をイベントとして流さないので、送った文と最初の文と再開の文は画面側で自分の欄に出すようにした。

## 残したこと

- 再開すると台帳のイベントが新しいプロセスの分からになるので、再開前の会話は画面に出ない（NonDBの帰結。jsonlにはある）。出したければ、生きているセッションでもSDKの履歴を先に読んで前に付ける。
- 拡張のresize_windowは効かず、375px幅の確認は手元のノードでagent-browserで行った分（Task 10）だけ。
