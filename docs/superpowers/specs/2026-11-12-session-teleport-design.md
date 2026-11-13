# セッションを別のノードへ移す（teleport）の設計

2026-11-12。依頼は meta-da から（konaito と合意済みの仕様4点つき）。実装はブランチ `feat/session-teleport`。

## 目的

- リモートのノードで動いている、または動いていたセッションを、手元の機械で再現して続ける。
- 手元で動いているセッション（ノードの子と端末の対話セッションの両方）を、別のノードへ渡して続けさせる。

## 合意済みの仕様（変えない）

1. 再現の範囲は会話と作業ツリー。会話の jsonl に加え、移動先の同じリポジトリに、移動元の HEAD、ブランチ、未コミットの差分、未追跡ファイルをそろえる。ignore の対象は送らない。
2. 移動元の扱いは2つから選ぶ。既定は move（移動元のプロセスを止め、続きは移動先だけで行う）。`--fork` では移動元を残し、移動先は別の id で分岐する。
3. 移動先のディレクトリは git の remote で探す（`ccn places` が返す remote を使う）。無ければ `~/Documents/<名前>` に clone する。それでも決まらなければ止めてエラーにする。
4. 手元に持ってきたセッションは、端末で `claude --resume <id>` の対話セッションとして開く。ノードの子にはしない。

## 調べて分かったこと

確かめた日はどれも 2026-11-12。SDK は 0.3.318、claude は手元が 2.1.322、vm が 2.1.318。

- 会話の置き場は `<設定ディレクトリ>/projects/<cwd の符号>/<id>.jsonl`。設定ディレクトリは `CLAUDE_CONFIG_DIR`、無ければ `~/.claude` になる。cwd の符号は、realpath の英数字以外を `-` に替えたもの。200字を超えると先頭200字に `-<djb2 の36進>` を足す。SDK の `sdk.mjs` の実装（`Pn`、`ju`、`nl`）を読んで確かめた。
- サブエージェントの会話は `<id>/subagents/agent-<x>.jsonl` に置かれる。`agent_metadata` の行は jsonl ではなく `agent-<x>.meta.json` に入る。SDK が `SessionStore.load` から resume 用の一時ファイルを作る処理（`iJ`、`o5e`）も同じ形で書いている。
- SDK には、会話をまるごと読み出す公式の関数 `importSessionToStore(id, store)` がある（alpha）。自分で作った store の `append` に、jsonl の1行ずつが JSON のまま届く。この会話（281行）で行数が一致し、サブエージェントの会話（23行）も別の key で届いた。
- SDK には、手元の任意の cwd へ会話を書き込む関数が無い。`SessionStore` を渡した resume は一時の設定ディレクトリに書くので、端末の `claude --resume` からは見えない。
- このノードの常駐は `CLAUDE_CONFIG_DIR` を持たず `~/.claude` を使う。端末は cam のプロファイル（`~/.cam/profiles/agent`）を使うが、その `projects` は `~/.claude/projects` への symlink なので、jsonl の置き場は同じになる。
- 会話を別の cwd の置き場に移して resume した試験の結果は次のとおり。
  - `cwd` を書き換えても書き換えなくても、`claude -p --resume` は会話を覚えたまま、新しい cwd で続いた。元のディレクトリを消しても続いた。
  - 書き換えないと、古い行の `cwd` は元のパスのまま残る。SDK の一覧の `cwd` は最初の行で決まるので、移動先の一覧に元のパスが出る。
  - 対話の `claude --resume <id>`（expect で起動）でも、置き直した会話が画面に出た。
  - 手元の Mac で作った会話を vm（Linux、2.1.318）の置き場に置いて `claude -p --resume` すると、会話を覚えたまま `/tmp/tp-e` で続いた。行の中の `session-owner`（アカウント）や版の違いで断られることはなかった。
- vm には git が無く、`~/Documents` も無い（2026-11-12 に確認）。

## 決めたこと

### 会話の運び方

- 読むときは SDK の `importSessionToStore` を使う。行の中身は解析せず、そのまま運ぶ。
- 書くときは、移動先で jsonl を直接書く。SDK に置き場を指定して書く関数が無いためで、書き方は SDK が resume 用の一時ファイルを作る処理と同じにする。符号の規則は SDK の非公開の実装なので、書いた直後に `getSessionInfo(id, { dir: cwd })` で SDK から見えるかを確かめる。見えなければ書いたファイルを消して失敗にする。こうすれば、規則が変わっても誤った場所に黙って置くことはない。history.ts の「jsonl を直接は読まない」方針はそのまま守り、直接触るのは移動先での書き込みだけにする。
- 書き換えるのは各行の `cwd` だけにする。移動元の cwd（とその realpath）で始まる値を、移動先の cwd に置き換える。理由は一覧の `cwd` を移動先に合わせるためで、resume はどちらでも通った。会話の本文（ツールの入力や結果のパス）は書き換えない。履歴を書き換えると、何が起きたかの記録が変わるため。
- fork は SDK の `forkSession` で移動元に別 id の写しを作り、それを読み出してから `deleteSession` で消す。id と uuid の付け替えを自分で書かないため。
- 運ばないものは、`<id>/tool-results/`（長いツール出力の退避先）、file-history（巻き戻しの記録。`forkSession` も写さない）、todos、memory。会話の中の `tool-results` へのパスは移動先では切れる。

### 移動先に同じ id があるとき

- 移動先で生きている（台帳にある、または `claude agents` に出る）なら止める（409）。
- 生きていない古い写しがあり、その行の uuid の並びが運んだ会話の先頭と一致するなら、置き換える。A から B へ移し、B で続けてから A へ戻すときに起きる。置き換えで古い写しの続きは失われない。別の cwd の置き場にあれば、SDK の `deleteSession` で消してから書く。
- 一致しなければ、同じ id の別の会話とみなして止める（409）。

### move の順序と、止められないセッション

- move は、移動先の下見、移動元を止める、書き出す、取り込む、の順に進める。止める前に書き出すと、その間に移動元が進んで分かれるため。止めても jsonl は残るので、取り込みが失敗しても移動元で `ccn new <cwd> --resume <id>` で再開できる。失敗の返事にはこの手順を書く。
- 移動元が動いている途中（running、waiting_permission）なら move を断る（409）。途中のターンを切らないため。待つか interrupt してからやり直す。
- 端末の対話セッション（TerminalDriver）は stop の能力が無い。生きている端末セッションを move するときは、fork に切り替えて移動先を別 id にし、警告を返す。同じ id のまま両方の機械で続くと、同じ id の別々の会話ができるため。端末は人が自分で閉じる。
- 過去のセッション（生きていない）の move は、止めるものが無いので書き出すだけにする。移動元の jsonl は消さない。
- ノードの子が自分自身を move すると、止めた時点で CLI ごと終わる。そこで止める、書き出す、取り込むの手順は移動元のノードが進める（`POST /api/sessions/:id/teleport`）。CLI の接続が切れても、ノードは最後まで進める。自分を移すとき、そのセッションは teleport を呼んだ Bash の途中なので running になる。呼び手の名前（`agent:<ノード>/<id の先頭8文字>/...`）がそのセッション自身なら、running でも止めて運ぶ。運ばれる会話は、終わっていない tool_use で終わる。
- 動いている途中かどうかと、まだ会話が無いかどうかは、下見（clone を含む）の前に見る。断るときに移動先へ clone を残さないため。
- 取り込んだ子は1通目まで claude を起動しないので、1通も届かないまま30分たつと台帳から消える。会話と作業ツリーは残るので、返事に `ccn new <cwd> --peer <移動先> --resume <id>` を付ける。
- 手元へ持ってくるとき、同じ id が手元で動いていれば（手元のノードの台帳か端末）、move なら止める。

### 作業ツリーの運び方

`git stash` は worktree 間で共有され、別のセッションの stash と混ざるので使わない。移動元で次のスナップショットを作り、git bundle で運ぶ。

1. `git write-tree` で今の index を tree にする（未解決の衝突があれば止める）。
2. 一時の index（`GIT_INDEX_FILE`）に今の index を写し、`git add -A` で作業ツリー全体（未追跡を含み、ignore は除く）を入れて tree にする。本物の index は触らない。
3. HEAD を親に index の commit（S1）、S1 を親に作業ツリーの commit（S2）を `git commit-tree` で作る。ブランチは動かさない。
4. 一時の ref `refs/ccn-teleport/<id>` を S2 に向け、`git bundle create <file> <ref> --not --remotes` で、remote に無い commit だけを束ね、ref を消す。

移動先では次の順に進める。

1. 下見で、作業ツリーがきれいか（`git status --porcelain --untracked-files=all` が空）、merge や rebase の途中でないかを見る。汚れていれば止め、汚れたファイルの一覧を返す。
2. remote から fetch してから `git bundle verify` で前提の commit がそろうかを見る。そろわなければ止める（移動元で push していない commit が remote から消えたときなど）。
3. bundle から一時の ref に取り込み、ブランチを合わせる。
   - 移動元がブランチ B にいて、移動先に B が無ければ HEAD から作る。
   - 移動先の B が HEAD と同じか HEAD の祖先なら、B を HEAD に進める（`git checkout -B`。作業ツリーはきれいなので何も消えない）。
   - 移動先の B が HEAD の祖先でなければ、移動先にしか無い commit があるので止める。
   - B が移動先の別の worktree で使われていれば止める。
   - 移動元が detached HEAD なら detached で HEAD に合わせる。
4. `git read-tree -m -u HEAD S2` で作業ツリーを S2 にし、`git read-tree S1` で index を S1 に戻す。これで、stage した変更、stage していない変更、削除、未追跡ファイル、実行権限、symlink、バイナリが git の仕組みのまま戻る。`read-tree -u` は上書きになる未追跡ファイルがあれば止まる。
5. 一時の ref を消す。

`reset --hard`、`clean`、`checkout -f` は使わない。移動元の作業ツリーは move でもそのまま残す。

### 移動先のディレクトリ

ホームの場所が機械ごとに違う（vm は `/home/konaito`）ので、移動先のノードの側で決める。運ぶのは、remote の url、リポジトリ名、リポジトリの中での相対パスだけにする。

- `--cwd <dir>` があればそれを使う。roots の内側で、git のリポジトリで、remote が一致することを確かめる。
- 無ければ、移動先の `places` から remote が一致するものを探す。比べる前に、`https://github.com/a/b.git`、`git@github.com:a/b`、`ssh://git@github.com/a/b` を `github.com/a/b` の形にそろえる。
  - 1つならそれを使う。
  - 2つ以上なら、名前がリポジトリ名と同じものに絞る。それでも1つにならなければ、候補を並べて止め、`--cwd` を求める。
  - 0なら `<home>/Documents/<リポジトリ名>` に `git clone` する。そこに別のものがあれば止める。
- `~/Documents` が無い機械（vm）では作る。決まりを機械ごとに変えないためで、空のディレクトリを1つ作るだけで何も消えない。`places` は `<root>/Documents` の直下も見るので、次からは clone したものが見つかる。
- 移動元が git でなければ作業ツリーは運ばない。移動元が受け口なら移動先の受け口に置き、それ以外は `--cwd` を求めて止める。
- 移動元が remote の無いリポジトリなら、探す手がかりが無いので `--cwd` を求めて止める。
- clone も下見の中で行う。clone は新しいディレクトリを作るだけで、既存の作業を消さないため。
- 取り込みでは移動先を探し直さず、下見で決まった場所を使う。下見で clone した直後は `places` の10秒の覚えに clone が載っておらず、探し直すと同じ場所へ clone し直そうとして止まった（2026-11-12 に vm で起きた）。あわせて、clone 先に remote が一致するリポジトリが既にあれば、`places` に出ていなくてもそれを使う。

### 運ぶ形と大きさ

- 運ぶもの（pack）は1つの JSON を gzip にしたもの。中身は、版、id、元の id（fork のとき）、移動元（ノード、cwd、受け口かどうか）、題、権限モード、会話の行（本体とサブエージェント）、git（remote、リポジトリ名、相対パス、ブランチ、HEAD、S1、S2、bundle の base64）、警告。
- 9MB の jsonl の会話もある。Cloudflare の要求の本文の上限（100MB）の手前の 90MB を pack の上限にし、超えたら止める。

### 出す場所

| 場所 | 操作 |
| --- | --- |
| HTTP | `POST /api/sessions/:id/teleport`（`to`、`fork`、`cwd`）。移動元のノードが、移動先の下見、止める、書き出す、取り込むを進める |
| HTTP | `POST /api/sessions/:id/export`（`fork`、`move`）。pack を返す。手元へ持ってくるときに CLI が使う |
| HTTP | `POST /api/teleport/check`（JSON の下見）と `POST /api/teleport`（pack の取り込み）。移動先のノードが受ける |
| CLI | `ccn teleport [<対象>] [--to <peer>] [--fork] [--cwd <dir>] [--no-open]` |
| MCP | `teleport_session`（`session`、`to`、`fork`、`cwd`） |
| 画面 | 今回は出さない |

- 新しく clone したディレクトリは Claude Code にとって未信頼なので、対話の `claude --resume` は最初に信頼の確認を出す。人が「Yes」を選べば会話が開く。
- `--to` を省くと手元の端末に持ってくる。CLI が移動元のノードから pack を受け取り、CLI のプロセスの中で取り込む。端末の `claude` と同じ `CLAUDE_CONFIG_DIR` を使うためで、ノードの常駐と端末で設定ディレクトリが違っても、`claude --resume` から見える。取り込んだら、端末なら移動先の cwd で `claude --resume <id>` を起動し、端末でなければ（Claude の Bash から呼んだときなど）その命令を表示する。
- `--to <peer>` なら、移動元のノードの `POST /api/sessions/:id/teleport` を呼ぶ。移動先のノードは取り込んだ会話を、1通目が届くまで claude を起動しないノードの子として台帳に載せる（今の遅延起動を resume にも使う）。
- 対象を省くと自分のセッション（`CLAUDE_CODE_SESSION_ID`）にする。
- 移動元と移動先が同じ機械の端末なら、何もすることが無いので止める。
- ノード間の pack の受け渡しは、中継と同じくノード用サービストークンで行う。取り込みは clone を含むので、待ちを15秒から95秒に延ばす。Cloudflare が応答の無いまま約100秒で切るため、その手前にした。
- 画面は今回は出さない。CLI と MCP で足り、画面には「移す先」を選ぶ部品が要るため。

## やらないこと

- 移動元の jsonl と作業ツリーを消すこと。
- submodule と Git LFS の中身を運ぶこと。gitlink だけが運ばれる。
- 移動先の作業ツリーが汚れているときに、上書きや退避をすること。
- 本番の他のノードへの配布。実機の確認は vm の本番ノードを枝の版に上げて行い、終わったら main の版に戻す（2026-11-12、konaito が meta-da の端末で承認）。
