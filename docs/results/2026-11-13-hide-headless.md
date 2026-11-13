# 裏方の claude -p を一覧から除く（#41）

## 何が起きたか

Claude Town と ccn.fybe.jp の一覧に、知らないセッションが数秒出て消えた。クリックしても会話は出なかった。

## 原因

`claude agents --json` は `claude -p` の実行も `kind: interactive` で返す。ccn は返った行をそのまま端末のセッション（kind terminal）にしていた。Stop hook の `~/.claude/hooks/close-check-state.py` は、セッションが止まるたびに `claude -p --no-session-persistence` を走らせる。jsonl を残さないので、クリックしても会話が出ない。

2026-11-13 に konaito-pro の /tmp で `claude -p` を走らせて確かめた。

- `claude agents --json` に `kind: interactive`、`name: tmp-64`、pid 付きの行が出た。
- `/tmp/cc-socks/<pid>.sock` もあった。受信ソケットの有無では見分けられない。
- `ps -o command=` に `-p` が独立した語で出た。

## 引数だけでは決めなかった理由

ccn の PTY の子は、最初の文を `claude` の引数で受ける。この修正を頼んだ文には `claude -p --no-session-persistence` が含まれていた。そのため、この作業をしたセッション（pid 98037）の `ps -o command=` に `-p` が独立した語で3回出た。引数だけで判定すると、このセッションが一覧から消える。

そこで制御端末も見る。対話のセッションは、人の端末でも PTY の子でも制御端末を持つ（ttys002 など）。close-check の子は `start_new_session=True` で起動され、制御端末を持たない（`??`）。launchd のジョブも制御端末を持たない。

## 直したこと

`src/engine/agents.ts` に `withoutHeadless` を足し、`src/main.ts` の `agents` に掛けた。`ps -o pid=,tty=,command= -p <pid,...>` を1回呼び、制御端末が無く、引数に `-p` か `--print` があるものを外す。pid が無い行、ps に出てこない行、ps が失敗したときは残す。PTY の子の状態合わせ（`agentInfo`）には掛けない。

macOS の ps は、問い合わせた pid が一部しか無くても終了コード 0 を返す。全部無いと 1 を返す。終了コードでは捨てず、stdout の行を読む。

## 確かめたこと

試験は `bun test`（366 pass、1 skip、0 fail）と `bunx tsc --noEmit -p .` で通した。`test/engine/agents.test.ts` に6件を足した。

実機では、worktree から別のポート（7799、`CCN_CONFIG=/tmp/ccn-41/ccn.json`）で修正版のノードを立てた。`start_new_session=True` で `claude -p`（haiku、Bash で sleep 8）を /tmp/ccn-41 に走らせ、1.5秒ごとに8回、両方のノードの `GET /api/sessions?state=live` を読んだ。

| 時点 | `claude -p` の tty | 本番のノード（4323、旧版） | 修正版のノード（7799） |
| --- | --- | --- | --- |
| 8回とも | `??` | `/private/tmp/ccn-41` が出た | 出なかった |

同じ時点で、修正版のノードの一覧は `claude agents --json` の10行を全部 terminal として出した。この作業をしたセッション（4c2caa3c、引数に `-p` を含む PTY の子）も残った。

## 残る制限

- 人が自分の端末で手で打った `claude -p` は、制御端末があるので残る。
- `claude agents --json` を読んでから ps を呼ぶまでの間に `-p` が終わると、その回だけ残る。
- 手元のノード（konaito-pro）への反映には `ccn update` が要る。`ccn update` はノードを再起動し、PTY のセッションが全部終わる。そのため反映していない。
