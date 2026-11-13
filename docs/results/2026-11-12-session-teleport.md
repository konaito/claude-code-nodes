# teleport（セッションを別のノードへ移す）の確認

2026-11-12。ブランチ `feat/session-teleport`。設計は `docs/superpowers/specs/2026-11-12-session-teleport-design.md`。確かめた手段を、bun test、tsc、実機に分けて書く。

## bun test と tsc

- `bun test` は 301件が通り、1件は飛ばした（既存の `CC_LIVE` の試験）。失敗は0件だった。
- `bunx tsc --noEmit -p .` はエラーなしで終わった。
- 足した試験は次のとおり。
  - `test/teleport/git.test.ts`（8件）。本物の git と一時リポジトリで確かめた。stage した変更、stage していない変更、stage した削除、未追跡、実行権限、symlink、バイナリ、push していない commit が移動先にそろうこと。ignore の対象（node_modules）は運ばないこと。移動元の index と ref が変わらないことも見た。止まる場合として、汚れた移動先、分岐したブランチ、前提の commit が無い場合を入れた。祖先のブランチは進めること、detached HEAD はそのままになることも確かめた。
  - `test/teleport/transcript.test.ts`（6件）。本物の SDK（`importSessionToStore`、`getSessionInfo`、`getSessionMessages`、`forkSession`、`deleteSession`）を、一時の `CLAUDE_CONFIG_DIR` で使った。置き場の名前が SDK と一致することを、短いパス、200字を超えるパス、日本語のパスで確かめた。書き戻しで書き換わるのが `cwd` だけであること、サブエージェントの `.meta.json` の扱い、古い写しの置き換えと別の会話の拒否、fork で移動元に写しが残らないことも見た。claude は使わない。
  - `test/teleport/api.test.ts`（15件）。2つのノードを同じプロセスで立てた。move で移動元を止め、移動先は遅延起動の子にすること、fork、running の移動元を断ること、汚れた移動先は下見で止めて移動元を止めないこと、生きている端末セッションを fork に切り替えることを確かめた。clone（`~/Documents` が無い場合を含む）と、places に clone が出ないときの扱い、clone 先に別のリポジトリがあるときの拒否も入れた。CLI で手元へ持ってくる流れも通した。ほかに、ノードの子が自分自身を move するとき running でも止めて運ぶこと、別のセッションからの move は断ること、busy を下見（clone）の前に断ること、取り込みの返事に再開の手順が付くこと、手元で同じ id が動いていれば手元への move を断ることを入れた。会話は偽の SDK で扱った。
  - `test/engine/node-driver.test.ts` に1件足した。resume と defer で、1通目まで claude を起動しないことを確かめた。
  - `test/mcp/mcp.test.ts` のツール一覧に `teleport_session` を足した。

## 実機

相手は vm（OrbStack の Ubuntu、claude 2.1.318）にした。手元の MacBook（konaito-pro、claude 2.1.322）は本番のノード（4323）を変えず、枝の版の試験ノードを別のポートで立てた。試験ノードは本番の `ccn.json` の写しで、port を 4399、lobby を `~/.cache/ccn-tp/lobby` に変えたもの。名前は konaito-pro のまま。トンネルは持たないので、外からの呼び出しは受けない。

### vm の準備

konaito が meta-da の端末で承認した範囲（git の導入、vm の本番ノードを枝の版に上げる、終わったら main の版に戻す）で行った。vm への操作は ccn で vm に子を立てて頼んだ。

- `sudo apt-get install -y git` は、パッケージ索引が古く 404 で失敗した。子が `sudo apt-get update` を足して入れ直し、`git version 2.53.0` が入った。
- `ccn update --from /Users/konaito/Documents/claude-code-nodes.wt/session-teleport` は、ノードの再起動で子ごと切れないように `systemd-run --user` で動かした。1回目は `exec: bun: not found` で失敗した。systemd-run の環境に `~/.bun/bin` が無かったためで、2回目は `--setenv=PATH=...` を付けて通った（「更新した: /home/konaito/.local/share/ccn/app。node を再起動した。」）。
- 承認の前の下調べで、`orb run -m ubuntu` から vm の `~/.claude/projects/-tmp-tp-e/` に jsonl を1本置き、`/tmp/tp-e` で `claude -p --resume` を1回動かした。書いたものは同じ日に消した。

### 1回目の move で見つかった不具合

試験ノードの子（`24d05012`、`/Users/konaito/.cache/ccn-tp/src`）を `ccn teleport konaito-pro/24d05012-… --to vm` で move した。返事は409だった。

- 何が起きたか。下見で vm の `~/Documents/ccn-teleport-test` に clone した。そのあとの取り込みで、「exists but its remote does not match」で止まった。
- 原因。取り込みで移動先を探し直したとき、`places` の10秒の覚えに、直前の clone が載っていなかった。そのため同じ場所へ clone し直そうとした。
- 影響。move の手順どおり、移動元は止まった状態で残った。返事の hint（`ccn new /Users/konaito/.cache/ccn-tp/src --peer konaito-pro --resume 24d05012-…`）で、そのまま再開できた。
- 直し方（9d5a3f7）。取り込みには下見で決まった場所を渡す。clone 先に remote が一致するリポジトリがあれば、places に出ていなくてもそれを使う。試験を3件足した。vm を直した版に上げ直した。

### move（手元の試験ノードの子 → vm）

1. 試験ノードで `--mode default` の子を立てて、「合言葉は「ぶどう314」」と送った（`konaito-pro/24d05012-35de-4fa8-bd69-70a1e2918b17`）。
2. 移動元の作業ツリーを次の状態にした。
   - ブランチ `feat/tp` に、push していない commit `cda6ac5` がある。
   - `a.txt` は、stage した内容（hello staged）と作業ツリーの内容（hello staged then edited）が違う。
   - `.gitignore` と `u.txt` は未追跡にした。
   - ignore の対象として `node_modules/x.js` を置いた。
   - `git status --porcelain` は `MM a.txt`、`?? .gitignore`、`?? u.txt` だった。
3. 1回目で止まった子を `--resume` で生き返らせた（state idle）。そのうえで `ccn teleport konaito-pro/24d05012-… --to vm` を実行した。出力は次のとおりで、終了コードは0だった。

```
vm/24d05012-35de-4fa8-bd69-70a1e2918b17
cwd: /home/konaito/Documents/ccn-teleport-test
git: feat/tp cda6ac5e（前は trunk 83b156ef）
mode: move（移動元は止めた）
```

4. 移動元の `ccn show` は `state: exited` になった。
5. vm で読んだ結果は次のとおり（`orb run` で読むだけ）。
   - `git status --porcelain` は移動元と同じ3行だった。
   - ブランチは `feat/tp` で、`cda6ac5 local only` があった。
   - `a.txt` は「hello staged then edited」、`git show :a.txt` は「hello staged」だった。
   - `node_modules` は無かった。
   - 会話は `~/.claude/projects/-home-konaito-Documents-ccn-teleport-test/24d05012-….jsonl` に置かれていた。
6. `ccn run vm/24d05012-… "前に覚えた合言葉は何？ それと pwd と git status --short の結果を、ツールで実行して答えて。"` を送った。返事は「合言葉は「ぶどう314」」で、pwd は `/home/konaito/Documents/ccn-teleport-test`、git status は上の3行だった。vm の `ccn show` は `cwd: /home/konaito/Documents/ccn-teleport-test`、`permissionMode: default` だった。移動元の権限モードが引き継がれた。

### fork（vm → 手元の端末）

1. `ccn teleport vm/24d05012-… --fork` を手元の CLI（試験ノードの設定）で実行した。手元の `~/Documents/ccn-teleport-test` は無かったので clone された。出力は次のとおりで、終了コードは0だった。

```
手元/30be0ff1-dced-4271-acc4-4158a5ff6e14
cwd: /Users/konaito/Documents/ccn-teleport-test（clone した）
git: feat/tp cda6ac5e（前は trunk 83b156ef）
mode: fork（移動元はそのまま、別の id）
開く: cd /Users/konaito/Documents/ccn-teleport-test && claude --resume 30be0ff1-dced-4271-acc4-4158a5ff6e14
```

2. vm の移動元は `state: idle` のまま残った。
3. 手元の `git status --porcelain`、ブランチ、`a.txt` の作業ツリーと index は、移動元と同じだった。会話は `~/.claude/projects/-Users-konaito-Documents-ccn-teleport-test/30be0ff1-….jsonl` に置かれた。CLI の環境の `CLAUDE_CONFIG_DIR`（`~/.cam/profiles/agent`）の `projects` は、`~/.claude/projects` への symlink である。
4. 対話の `claude --resume 30be0ff1-…` を expect で起動した。新しく clone したフォルダなので、最初に信頼の確認が出た。「Yes, I trust this folder」を選ぶと、画面に「ぶどう」が出た。この操作で、試験のフォルダの信頼の記録が cam の agent プロファイルの設定に1件増えた。
5. 同じディレクトリで `claude -p --resume 30be0ff1-… "合言葉と、今の作業ディレクトリと OS を1行で。"` を実行した。返事は「合言葉は「ぶどう314」。作業ディレクトリは `/Users/konaito/Documents/ccn-teleport-test`、OS は macOS」だった。

### 汚れた移動先で止まること

fork のあとの手元の `~/Documents/ccn-teleport-test`（変更が3つある）へ、vm のセッションを move で持ってこようとした（`ccn teleport vm/24d05012-…`）。結果は次のとおり。

- 出力は「移動先を決められない: the destination working tree has changes (3 files)」で、終了コードは1だった。
- vm のセッションは `state: idle` のままだった（止まっていない）。
- 手元の作業ツリーは変わらなかった。

### 自分自身を移す（手元の試験ノードの子 → vm）

2つ目の試験リポジトリ（`~/.cache/ccn-tp/src2`、作業ツリーはきれい）で、試験ノードの子（`konaito-pro/76117a5f-…`、bypassPermissions）を立てた。子は合言葉「もも55」を覚えたあと、自分の Bash で `ccn teleport` を実行した。対象を省いたので、`CLAUDE_CODE_SESSION_ID` の自分が対象になった。子の `which ccn` は枝の `bin/ccn`、`CCN_CONFIG` は試験ノードの設定だった。

- fork（`ccn teleport --to vm --fork`）。返事は `vm/fbe28003-…`、`cwd: /home/konaito/Documents/ccn-teleport-test2（clone した）` だった。vm でその子に送ると、合言葉「もも55」を答え、pwd は `/home/konaito/Documents/ccn-teleport-test2` だった。運んだ会話は、teleport を呼んだ Bash の途中で終わっている。
- move（`ccn teleport --to vm`）。子は running のまま自分を移した。移動元の `ccn show` は `state: exited` になった。vm の一覧には `vm/76117a5f  node  idle  /home/konaito/Documents/ccn-teleport-test2` が出た。vm で送ると、合言葉「もも55」を答えた。返事には「直前は Mac で `ccn teleport --to vm` を1回実行した。会話の記録ではそのコマンドの結果が中断扱いで残っていない」とあった。

### ccn teleport が端末で claude --resume を開く

expect の端末（TTY）で `ccn teleport vm/76117a5f --fork --cwd /Users/konaito/.cache/ccn-tp/pull2` を実行した。`pull2` は2つ目の試験リポジトリのきれいな clone である。

- 出力は `手元/9eeeb828-…` と `mode: fork` で、CLI はそのまま `claude --resume` を起動した。
- 信頼の確認が出たので「Yes」を選ぶと、画面に「もも55」が出た。
- vm の移動元は idle のまま残った。手元の `pull2` の `git status --short` は空だった。
- この操作でも、信頼の記録が1件増えた。

## 確かめていないこと

- 手元の本番ノード（4323、トンネル経由で受ける側）が teleport を受けること。手元は試験ノードで、本番は変えていない。vm から手元への `--to konaito-pro`（vm のノードが手元の本番ノードの `/api/teleport` を呼ぶ道）は試していない。
- 生きている端末セッションの move（fork に切り替える）は bun test だけで確かめた。実機では試していない。
- 手元へ持ってくるときに、同じ id が手元で動いていれば断ること。bun test だけで確かめた。
- GitHub の remote。実機の試験の remote は、Mac と vm の両方から同じパス（`/Users/konaito/.cache/ccn-tp/…`）で見えるローカルの bare リポジトリだった。ssh と https の形の正規化は bun test だけで確かめた。認証つきの clone と fetch は試していない。vm と incertotech には gh が無い。
- サブエージェントの会話を含むセッションの実機の移動。SDK での読み書きは bun test で確かめた。
- 大きな会話（数 MB 以上）を運ぶときの時間と、Cloudflare の打ち切り（約100秒）。
- MCP の `teleport_session` を実機の MCP クライアントから呼ぶこと。試験は一覧に出ることだけを見た。
- incertotech。

## 2026-11-13 main への rebase と追加の確認

マージの前に、枝を main（8b3b6a4）へ rebase した。main は枝の分岐元（086d910）から51件進み、PTY のセッション、深さの制限、一覧の SSE が入っていた。

### rebase

- 衝突は `src/api/app.ts`、`src/api/errors.ts`、`src/api/sessions.ts` の3つだった。どれも両方の分岐を残して解いた（端末の口と teleport の口、`BusyError` と teleport の例外、深さと一覧の監視の import と teleport の import）。
- rebase の直後の `bun test` は 434件が通り、1件は飛ばした。失敗は0件だった。`bunx tsc --noEmit -p .` はエラーなしで終わった。

### 見つかった不具合: Claude Town の計画の要求で本当に移る

- 何が起きたか。Claude Town の転出の画面は、子孫のいるセッションでは、開いた時点で `{"to", "fork", "subtree": true, "dryRun": true}` を `POST /api/sessions/:id/teleport` に送る（family-computing の `src/App.tsx` の `Teleport`）。この枝は `subtree` と `dryRun` を読まず、普通の move として親だけを移していた。
- 確かめ方。`test/teleport/api.test.ts` に試験を足し、`dryRun: true` で 200 が返り移動元が止まることを、直す前に失敗として見た。
- 原因。ccn に、子孫ごと移す口（subtree）と計画だけ返す口（dryRun）が無い。全部のブランチを `git grep` しても実装は無かった。
- 直し方（1bbcde7）。`subtree` か `dryRun` に false 以外の値があれば、下見の前に 501（`code: "unsupported"`）で断る。false は付けないのと同じに扱う。試験を2件足した。
- 影響。Claude Town で子孫のいるセッションの転出は、計画も実行もエラーになる。子孫のいないセッションの転出は、`subtree` と `dryRun` を送らないので、これまでどおり動く。

直したあとの `bun test` は 436件が通り、1件は飛ばした。失敗は0件だった。`tsc` はエラーなしだった。

### 実機: PTY のセッションの move

これまでの実機の確認は node のセッションだけだった。Claude Town のセッションの多くは PTY なので、rebase した枝で PTY のセッションを移した。

- 立て方。同じ機械に試験ノードを2つ立てた（tp-a は 4431、tp-b は 4432）。本番のノード（4323）は変えていない。起動は family-computing の `docs/research/teleport-parent-test/launch.ts` を、この worktree に向けたものを使った。登録簿を2ノードの StaticRegistry にし、History と teleport の SDK 呼び出しをノードごとの cwd に絞り、端末の一覧（`claude agents`）を空にしてある。claude は 2.1.323 で、モデルは既定のままにした。
- 試験のリポジトリ。ローカルの bare リポジトリを `/private/tmp/ccn-tpv/a/proj`（tp-a）と `/private/tmp/ccn-tpv/b/proj`（tp-b）に clone した。tp-a の側は `a.txt` を変更し、`u.txt` を未追跡にした。

手順と結果は次のとおり。

1. tp-a に `terminal: true` でセッションを立て、「合言葉は「すだち77」」と送った（`f99e5950`、kind pty、claude の pid 93308）。返事は「OK」で、state は idle になった。
2. Claude Town の計画の要求と同じ body（`subtree: true`、`dryRun: true`）を送った。返事は 501 の `subtree is not supported by tp-a; teleport moves one session at a time` だった。tp-a のセッションは idle のまま、pid も同じだった。tp-b の `GET /api/sessions/f99e5950-…` は 404 で、tp-b の作業ツリーも変わらなかった。
3. `{"to": "tp-b", "cwd": "/private/tmp/ccn-tpv/b/proj"}` で move した。返事は 200 で、id は同じだった。
4. move の後の状態。
   - pid 93308 は `ps` に無かった。
   - tp-a の一覧では `f99e5950 node exited` になった。
   - tp-b の一覧では `f99e5950 node idle`（awaitingFirst）になった。移動先では PTY ではなく、遅延起動のノードの子になる。
   - tp-b の作業ツリーは ` M a.txt` と `?? u.txt` で、`a.txt` の中身は移動元と同じだった。
5. tp-b に「前に覚えた合言葉は？」と送ると、返事は「すだち77」だった。
6. 別の PTY のセッション（`388e3717`）に長い出力を頼み、running の間に move した。返事は 409 の `busy` で、tp-a のセッションは running のままだった。tp-b には何も作られなかった（404）。

終わったあと、試験のセッションを DELETE で止め、試験ノード2つを自分の pid で止め、`~/.claude/projects` の試験の置き場2つを消した。

### 2026-11-13 の時点で確かめていないこと

- 上の「確かめていないこと」は、PTY のセッションの move を除いて残る。
- 子孫ごとの転出（subtree）と計画（dryRun）。ccn には無い。
- 取り込みは `Sessions.create` を通らないので、移動先で深さを刻まない。移したセッションの深さは、深さの規則（`src/api/depth.ts`）のとおり、呼び手と最初の文の from 行から後でたどる。
- PTY のセッションを、移動先でも PTY として再開すること。今は node の子として再開する。
