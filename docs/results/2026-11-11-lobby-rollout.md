# 受け口の版を本番の3台に配った記録（2026-11-11）

PR #15（e725a26）の版を、konaito-pro、incertotech、vm の3台に配った。作業は konaito-pro の Specter のペインから行った。このペインはノードが立てたセッションではなく、端末のセッションである。vm には `orb run -m ubuntu`、incertotech には `ssh incertotech` で入った。本人は親のセッションで、マージと3台への配布を任せた。

e725a26 の版では、incertotech の `ccn places` が返らなかった。親の判断で incertotech は戻さず、修正を PR #17（5a1b160）で配った。修正を配った後、incertotech でも places が返り、受け口から子が立った。結果は「places の修正（PR #17）を3台に配った記録」の節にある。

## 結果のまとめ

| 確かめたこと | konaito-pro | incertotech | vm |
| --- | --- | --- | --- |
| 更新前の中身 | ec596c5（PR #13） | ec596c5 | ec596c5 |
| 更新後の中身 | e725a26 | e725a26 | e725a26 |
| `ccn doctor` | claude の版の ng だけ（前と同じ） | claude の版の ng だけ（前と同じ） | 全部 ok |
| `/api/host` の lobby | 返る | 返る | 返る |
| 受け口の CLAUDE.md と settings.json | ある。allow は10件 | ある。allow は10件 | ある。allow は10件 |
| `ccn places --peer` | 返る（283件中60件） | 返らない。5a1b160 では返る（下の節） | 返る（1件） |
| 受け口から子 | 立った。受け口の承認0回 | 5a1b160 で立った。受け口の承認0回（下の節） | 立った。受け口の承認0回 |

## 更新の前に記録したこと

- 版を表す番号はノードに無い。そこで、`src`、`skills`、`bin`、`package.json`、`bun.lock` の各ファイルの sha256 をまとめた値で比べた。`._` で始まるファイルは除いた。git の各コミットを `git archive` で取り出し、同じ計算をした。
- konaito-pro と incertotech の値は `689bbf30bd47` だった。この値は ec596c5（PR #13）、d4fd915、49d5999 と同じである。この3つはコードが同じで、違うのは docs だけである。e725a26 は `6f6d3af9a1d3` になる。
- vm の値は、`._` で始まるファイルを含めて計算したので `59f53b1bf5f3` になった。束から入った macOS の AppleDouble のファイル（`bin/._ccn`、`src/._api` など）が余分にあったためである。そこでファイルごとの sha256 を ec596c5 と diff で比べた。`._` で始まるファイルを除くと一致した。
- `ccn peers` では、3台とも healthy だった。
- `ccn ls` で見ると、生きている node セッションは3台とも0件だった。exited は konaito-pro が95件、incertotech が44件、vm が20件あった。update はノードを再起動するが、切れるセッションは無かった。
- vm の常駐の PATH には `~/.bun/bin` と `~/.local/bin` があった。`systemctl --user show ccn-node -p Environment` で見た。

## 更新

前回の配り方に合わせて、3台を続けて `ccn update --from` で更新した。入口は incertotech である。

| 台 | 時刻 | 入れた元 | 束の値の確認 |
| --- | --- | --- | --- |
| konaito-pro | 19:48:54〜19:48:56 | `~/Documents/claude-code-nodes`（main、e725a26、作業ツリーは clean） | 作業ツリーが `6f6d3af9a1d3` |
| incertotech | 19:49:08〜19:49:09 | `https://ccn-konaito-pro.fybe.jp/install/ccn.tar.gz` を展開したもの | 展開後が `6f6d3af9a1d3` |
| vm | 19:49:18 | `https://ccn.fybe.jp/install/ccn.tar.gz`（更新後の incertotech）を展開したもの | 展開後が `6f6d3af9a1d3` |

3台とも、出力は「更新した: …。node を再起動した。実行物は ccn」で、終了コードは0だった。束の値が合わなければ止める作りにしておいた。vm の tar は、macOS の xattr について90行の警告を出した。前回の記録と同じで、展開は成功した。

## 各台での確認（コマンド）

更新後に `~/.local/share/ccn/app` の値を計算すると、3台とも `6f6d3af9a1d3` だった。

### ccn doctor

- konaito-pro では `ng claude 2.1.322`（試験済みは 2.1.318）だけが ng で、残りは ok だった。
- incertotech では `ng claude 2.1.319` だけが ng で、残りは ok だった。
- vm では全部 ok だった（claude 2.1.318）。
- どの台も、更新前の doctor と同じ結果だった。

### /api/host

`curl -s 127.0.0.1:<port>/api/host` で見た。lobby は次のとおり返った。

- konaito-pro（4323）: `/Users/konaito/.local/share/ccn/lobby`
- incertotech（4323）: `/Users/konaito/.local/share/ccn/lobby`
- vm（4322）: `/home/konaito/.local/share/ccn/lobby`

### 受け口のファイル

3台とも、`lobby/CLAUDE.md`（87行）と `lobby/.claude/settings.json` ができていた。時刻は更新の時刻と同じだった。CLAUDE.md の見出しは「受け口（Claude Code Nodes、<台>）」だった。settings.json を bun で読むと、3台とも同じ形だった。

- `permissions.allow` は10件で、`Bash(ccn peers *)`、`places`、`ls`、`show`、`new`、`run`、`read`、`allow`、`deny`、`stop` だった。
- `permissions.deny` は14件だった。
- 鍵は `permissions` だけだった。

### ccn places --peer

- konaito-pro: 返った。283件のうち60件を返し、`truncated` は true だった。
- vm: 0.7 秒で返った。候補は1件（`/home/konaito/work`）だった。
- incertotech: 返らなかった。下の節に書く。

## incertotech の places（e725a26 の版）

### 何が起きた

- konaito-pro から `ccn places --peer incertotech` を実行すると、Cloudflare の 524 になった。この要求は konaito-pro のノードが中継し、`ccn-incertotech.fybe.jp` を通る。入口（ccn.fybe.jp）は通っていない。
- incertotech の中から `127.0.0.1:4323/api/places` を叩いても、60 秒で応答が無かった。同じノードの `/api/host` は 0.04 秒で返った。
- `sample` でノードのプロセスを2秒見た。2本のスレッドが、その間ずっと `__openat_nocancel` で止まっていた。

### 原因の見立て（未確認）

places は roots の直下の各ディレクトリを readdir し、`~/Documents` の直下も読む。incertotech の roots は `/Users/konaito` で、直下に Desktop、Documents、Downloads、Movies、Music、Pictures がある。incertotech の利用者の TCC.db（ssh から sqlite3 で読めた）には、bun の記録が1件も無い。macOS のフォルダの承認待ちで `openat` が止まっている、と見ている。

- rdc の `screenshot` は「no displays found」を返した。承認のダイアログは画面で確かめていない。
- どのパスで止まっているかは特定していない。
- konaito-pro でなぜ止まらないかも確かめていない。konaito-pro の TCC.db は、このペインからは開けなかった。

### 他の API への影響（HTTP）

止まったスレッドがあるまま、incertotech の中から3秒おきに5回叩いた。

| API | 5回の結果 |
| --- | --- |
| `/api/host` | 5回とも 200、0.036〜0.039 秒 |
| `/api/sessions` | 5回とも 200、0.154〜0.155 秒 |
| `/api/peers` | 5回とも 200、0.0006〜0.31 秒 |

konaito-pro からの `ccn ls --peer incertotech` も 0.4 秒で返った。このときノードのスレッドは18本、RSS は約 225MB だった。スレッドの数は `ps -M` の見出しを除いた行数である。

止まったスレッドの数も数えた。places を始めたのは3回である。中継の `ccn places --peer incertotech` が2回（2回目の `--json` は手元で打ち切った）、incertotech の中の curl が1回である。1回目の `sample` では、`openat` で止まったスレッドが2本だった。親の指示で places を呼ぶのをやめた後、2回目の `sample` では3本だった。1回目の `sample` の時点で、中継の2回目がノードに届いていたかは確かめていない。そのため「呼ぶたびに1本増える」とまでは言えない。2回目のときのスレッドは全部で14本だった。

画面（`src/web/index.html`）は `/api/places` を呼ばない。呼ぶのは CLI の `ccn places` と MCP の `list_places` だけである。画面を開いただけでは止まったスレッドは増えない。

### 決めたこと

親の判断で、incertotech は前の版に戻さない。places が保護されたフォルダを読まないようにする修正は、別の子が担当している。受け口の手順は `ccn places` を呼ぶので、incertotech の受け口は修正が入るまで places で止まる見込みである。

## 受け口から子を立てる試験（konaito-pro と vm）

各台のホームの直下に、試験用ディレクトリ `ccn-lobby-rollout-test` を作った。中身は1行の説明を書いた README だけである。places がこのディレクトリを候補に出すことを、`ccn places rollout --peer <台>` で先に確かめた。

その後の手順は次のとおり。

1. `ccn new --peer <台> --mode default` で、プロンプトなしの受け口を開いた。
2. `ccn send` で次の文を送った。「試験用ディレクトリ ccn-lobby-rollout-test（README に「受け口の試験用」とあるもの）に hello.txt を1行で作ってください。中身は hello from lobby の1行だけ。ほかのディレクトリやプロジェクトには触らないでください。」
3. `ccn read` で返事を読み、`ccn show` で子を見た。

| | konaito-pro | vm |
| --- | --- | --- |
| 受け口 | `364ce44a-aa09-422e-8239-b53d488c9fee`、default、cwd は lobby | `2045ddf8-691e-487e-809a-81c1dded8537`、default、cwd は lobby |
| 受け口の parent | `agent:konaito-pro/2ce79a1b/parent` | `agent:konaito-pro/2ce79a1b/parent` |
| 受け口のツール呼び出し | 7回 | 7回（places、show、new、read、show、allow、read） |
| 受け口自身の承認 | 0回 | 0回 |
| 返事の `子:` の行 | `子: konaito-pro/ac36f9af-65c7-43e3-bbff-4b6bb78bd298` | `子: vm/08e6e513-95d9-459b-a667-9f6381da0273` |
| 子の cwd | `/Users/konaito/ccn-lobby-rollout-test` | `/home/konaito/ccn-lobby-rollout-test` |
| 子の parent | `agent:konaito-pro/364ce44a/lobby` | `agent:vm/2045ddf8/lobby` |
| 子のモードとモデル | default、claude-opus-5-5 | default、claude-sonnet-5-5 |
| 子の承認 | Write が1回。受け口が `pending:` の `file_path` を見てから allow | Bash が1回（`printf 'hello from lobby\n' > hello.txt && cat hello.txt`）。受け口が `ccn show` を見てから allow |
| できたファイル | `hello from lobby\n`（17バイト、`od -c`） | `hello from lobby\n`（17バイト、`od -c`） |

受け口自身の承認の回数は、受け口の `ccn read --after 0` に出る `[permission]` の行を数えた。どちらも0行だった。

vm の受け口は、子に allow する前の1文を英語で書いた（「The command only writes hello.txt in the target directory…」）。ほかの返事は日本語だった。

### 片づけ

試験で立てた4つ（受け口2つと子2つ）を `ccn stop` で止め、`ccn ls` で exited になったことを見た。試験用ディレクトリは2台とも消した。片づけの後、3台で生きている node セッションは0件だった。

## 外からの確認（HTTP）

- `https://ccn.fybe.jp/skill.md` は 200 で、`text/markdown` の 13,969 バイトだった。中身は、`skills/claude-code-nodes/SKILL.md`（e725a26）の `{{ORIGIN}}` を `https://ccn.fybe.jp` にしたものと diff で一致した。「受け口」の節と `ccn:list_places` がある。
- 未認証の `POST https://ccn.fybe.jp/mcp`（initialize）は 401 だった。`www-authenticate: Bearer realm="OAuth", error="invalid_token"` が付き、`resource_metadata` は `https://ccn.fybe.jp/.well-known/cloudflare-access-protected-resource/mcp` だった。
- 未認証の `https://ccn.fybe.jp/api/host` は 401、`/install` は 200 だった。

## 確かめていないこと

- incertotech の places が止まる原因。TCC の承認待ちという見立ては、画面でもログでも確かめていない。
- 画面（https://ccn.fybe.jp）の「新しく」で場所を空にして開く経路。この試験では CLI だけを使った。
- 別の機械の受け口への受け渡し（ひな形の手順3）。
- bypassPermissions と auto の受け口。

## places の修正（PR #17）を3台に配った記録

PR #17（5a1b160）の版を、同じ3台に配った。作業の場所と入り方は、上の配布と同じである。PR #17 は、places が保護フォルダを開かないようにし、fs の呼び出し1回に1秒、走査全体に3秒の上限を付ける修正である。

### 結果のまとめ

| 確かめたこと | konaito-pro | incertotech | vm |
| --- | --- | --- | --- |
| 更新前の中身 | e725a26（`6f6d3af9a1d3`） | e725a26 | e725a26 |
| 更新後の中身 | 5a1b160（`0ff8d8397e95`） | 5a1b160 | 5a1b160 |
| `ccn doctor` | claude 2.1.322 の ng だけ（前と同じ） | claude 2.1.319 の ng だけ（前と同じ） | 全部 ok |
| `/api/host` の lobby | 返る | 返る | 返る |
| `ccn places --peer`（1回目、2回目） | 0.52 秒、0.08 秒。278件中60件 | 1.32 秒、0.17 秒。58件、partial | 0.37 秒、0.18 秒。1件 |
| places の partial と note | false、なし | true。`/Users/konaito/Documents` が unreadable | false、なし |
| 出力の中の保護フォルダ | 0件 | 0件 | 0件 |
| openat で止まったスレッド | 数えていない | 更新前3本、更新直後0本、places の後1本 | 数えていない |
| 受け口から子 | 今回は試していない（e725a26 では立った） | 立った。受け口の承認0回 | 今回は試していない（e725a26 では立った） |

### 更新の前に記録したこと

- 中身の値は、上の節と同じ計算で出した。`src`、`skills`、`bin`、`package.json`、`bun.lock` の各ファイルの sha256 をまとめた値で、`._` で始まるファイルは除く。e725a26 を `git archive` で取り出すと `6f6d3af9a1d3` になり、前回の値と一致した。5a1b160 は `0ff8d8397e95` になる。
- 3台の `~/.local/share/ccn/app` の値は、どれも `6f6d3af9a1d3` だった。
- `ccn peers` では、3台とも healthy だった。
- `ccn ls --peer <台>` で見ると、生きている node セッションは3台とも0件だった。konaito-pro には端末のセッションが6件あった。
- `ccn doctor` は、konaito-pro と incertotech が claude の版の ng だけで、vm は全部 ok だった。
- incertotech のノード（pid 99822）を `sample` で2秒見た。`__openat_nocancel` で止まったスレッドは3本で、3本とも2秒の間ずっと止まっていた。スレッドは全部で17本、RSS は約 243MB だった。

### 更新

上の配布と同じ順番と束で、3台を `ccn update --from` で更新した。

| 台 | 時刻 | 入れた元 | 束の値の確認 |
| --- | --- | --- | --- |
| konaito-pro | 20:12:55〜20:12:56 | `~/Documents/claude-code-nodes`（main、5a1b160、作業ツリーは clean） | 作業ツリーが `0ff8d8397e95` |
| incertotech | 20:13:05〜20:13:06 | `https://ccn-konaito-pro.fybe.jp/install/ccn.tar.gz` を新しい空のディレクトリに展開したもの | 展開後が `0ff8d8397e95` |
| vm | 20:13:24 | `https://ccn.fybe.jp/install/ccn.tar.gz`（更新後の incertotech）を同じく展開したもの | 展開後が `0ff8d8397e95` |

3台とも、出力は「更新した: …。node を再起動した。実行物は ccn」で、終了コードは0だった。束の値が合わなければ止める作りにしておいた。

incertotech では、vm に進む前に次を確かめた。

- 旧のノードの pid 99822 は、`ps` で見ると無くなっていた。止まったスレッドを抱えていたが、`ccn update` の再起動で終わった。再起動は、コードを読むと `launchctl kickstart -k` である。
- 新しいノードは pid 1199 で、`lsof` で見ると 127.0.0.1:4323 を持っていた。
- `/api/host` は 200 で、app の値は `0ff8d8397e95` だった。

更新後の app の値は、3台とも `0ff8d8397e95` だった。

### 各台での確認（コマンド）

- `ccn doctor` の結果は、3台とも更新前と同じだった。
- `curl -s 127.0.0.1:<port>/api/host` の lobby は、konaito-pro と incertotech が `/Users/konaito/.local/share/ccn/lobby`、vm が `/home/konaito/.local/share/ccn/lobby` だった。
- `ccn places --peer <台> --json` を、konaito-pro から各台に2回ずつ実行した。時間は呼び出しの前後の時刻の差である。結果はまとめの表のとおり。
- 保護フォルダの一覧は `src/lobby/places.ts` の `MAC_PROTECTED`（Desktop、Downloads、Library、Pictures、Music、Movies、Public、Applications、iCloud Drive）と `/Volumes` である。出力の `places[].path` を grep で照合し、3台とも0件だった。`~/Documents` はこの一覧に入っていない。

### incertotech の places と止まったスレッド

- places は返った。候補は58件で、どれもホームの直下だった。
- `~/Documents` の下の候補は1件も出なかった。`~/Documents` は1秒の上限で読めず、`unreadable` に入った。note は「some folders did not answer in time and were skipped: /Users/konaito/Documents」だった。CLI の表示では「一部のフォルダを読めなかった（時間切れ）」と出る。
- konaito-pro では、`~/Documents` の下の候補が56件出た。

`sample` で数えた止まったスレッドの数は次のとおり。どれもノードの pid 1199 を2秒見た。

| 時点 | openat で止まったスレッド | スレッドの数 |
| --- | --- | --- |
| 更新の直後（places を呼ぶ前） | 0本 | 15本 |
| places を2回呼んだ後 | 1本（Thread_8717426） | 17本 |
| 3回目を呼んで5秒後 | 1本（同じ Thread_8717426） | 20本 |
| 受け口の試験の後（受け口が places を1回呼んだ） | 1本 | 19本 |

1回目と2回目の間には sample を取っていない。そのため、1本目が1回目の呼び出しでできたことは確かめていない。2回目以降の呼び出しでは、止まったスレッドは増えなかった。止まったスレッドが `~/Documents` を開いているかは、sample では分からないので確かめていない。

### incertotech の受け口から子を立てる試験

前回の konaito-pro と vm と同じ形で行った。ホームの直下に `ccn-lobby-rollout-test` を作り、「受け口の試験用」の1行の README を置いた。`ccn places rollout --peer incertotech` がこのディレクトリを1件返すことを先に確かめた。その後、`ccn new --peer incertotech --mode default` で受け口を開き、前回と同じ文を `ccn send` で送った。

| | incertotech |
| --- | --- |
| 受け口 | `96da32ad-f058-4f7c-bac5-db8919c58366`、default、cwd は lobby、claude-sonnet-5-5 |
| 受け口の parent | `agent:konaito-pro/7fbf53b3/parent` |
| 受け口のツール呼び出し | 7回（places、show、new、read、show、allow、read） |
| 受け口自身の承認 | 0回 |
| 返事の `子:` の行 | `子: incertotech/43f9344a-edc8-431b-86a9-37b68d7f0854` |
| 子の cwd | `/Users/konaito/ccn-lobby-rollout-test` |
| 子の parent | `agent:incertotech/96da32ad/lobby` |
| 子のモードとモデル | default、claude-sonnet-5-5 |
| 子の承認 | Write が1回。受け口が `ccn show` で `file_path` を見てから allow |
| できたファイル | `hello from lobby\n`（17バイト、ssh で `od -c`） |

受け口自身の承認の回数は、受け口の `ccn read --after 0` に出る `[permission]` の行を数えた。0行だった。vm と同じく、受け口は allow の前後の2文を英語で書いた（「Confirm the pending content first.」など）。ほかの返事は日本語だった。

片づけとして、受け口と子を `ccn stop` で止め、`ccn ls` で exited になったことを見た。試験用ディレクトリは消した。片づけの後、3台で生きている node セッションは0件だった。

### 外からの確認（HTTP）

- `https://ccn.fybe.jp/skill.md` は 200 で、`text/markdown` の 14,139 バイトだった。中身は、5a1b160 の `skills/claude-code-nodes/SKILL.md` の `{{ORIGIN}}` を `https://ccn.fybe.jp` にしたものと diff で一致した。
- 未認証の `POST https://ccn.fybe.jp/mcp`（initialize）は 401 だった。`www-authenticate` は前回と同じだった。
- 未認証の `https://ccn.fybe.jp/api/host` は 401、`/install` は 200 だった。
- `ccn peers` では、3台とも healthy だった。

### 確かめていないこと（5a1b160）

- incertotech で `~/Documents` が読めない原因。TCC の承認待ちという見立ては、今回も画面でもログでも確かめていない。TCC の設定には触っていない。
- 止まったスレッド（1本）がノードの終わりまで残るか。次の再起動で消えるかは見ていない。
- konaito-pro と vm の止まったスレッドの数。sample は incertotech でだけ取った。
- 画面と MCP の `list_places` からの呼び出し。今回は CLI だけを使った。
- konaito-pro と vm の受け口から子を立てること。5a1b160 では試していない。
