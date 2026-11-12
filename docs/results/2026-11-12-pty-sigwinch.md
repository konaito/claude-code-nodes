# PTY のセッションで resize が claude に届かない不具合の確認（2026-11-12）

PTY のセッションで端末の大きさを変えても、claude は作成時の桁数のまま描いていた。Claude Town の子 family-computing-2 が見つけた。この記録は、原因を確かめた手順と直した後の結果を残す。

## 原因の確認

### 素の Bun の台本

`sh` を PTY で起動し、WINCH の trap の中でだけ `stty size` を出させた。resize の後に trap の行が出るかと、`ps` の TTY と STAT を見た。

| spawn の形 | bun 1.3.11 macOS | bun 1.3.14 macOS | bun 1.4.4 Linux（orb の ubuntu） |
| --- | --- | --- | --- |
| `new Bun.Terminal()` を渡す（直す前） | TTY `??`、WINCH 届かず | 同左 | TTY `?`、WINCH 届かず |
| `terminal: { cols, rows, data }` を渡す（直した後） | `Ss+`、WINCH 届く | 同左 | 同左 |
| `Bun.Terminal` と `detached: true` | `Ss+`、WINCH 届く | 同左 | TTY `?`、WINCH 届かず |
| options と `detached: true` | `Ss+`、WINCH 届く | 同左 | 同左 |

直す前の形でも、手で `kill -WINCH` を送ると `stty size` は新しい大きさを返した。大きさは `term.resize` で変わっていて、届いていないのはシグナルだけだった。

公式の説明（bun-types の `bun.d.ts` と `docs/runtime/child-process.mdx`）には、渡し方で制御端末が変わることは書いていない。書いてあるのは、`detached` が `setsid()` を呼ぶことだけである。表の違いは上の3つの版での実測による。

### 試験用のノードと本物の claude

127.0.0.1 の 4391 に直す前の版（356a653 を `git archive` で取り出したもの）、4392 に直した後の版を、別の `CCN_CONFIG` で立てた。常駐の 4323 には触っていない。それぞれで `terminal: true`、cols 120、rows 40 のセッションを、このリポジトリを cwd にして立てた。8秒待ってから端末の SSE を読み、`POST …/terminal/resize` で 60x20 にした。その後3秒間に届いた data を見た。

| | 直す前（4391） | 直した後（4392） |
| --- | --- | --- |
| claude の `ps` | TTY `??`、STAT `SN`、pgid はノードと同じ | TTY `ttys002`、STAT `SNs+`、pgid は claude 自身 |
| resize の後の data | 208 バイト。120x40 の座標（行34〜40、桁50）への部分描画だけ | 1268 バイト。`ESC[2J` で消して、罫線を60桁で描き直した |

## 直し方

`bunPtySpawn` で、`Bun.spawn` の `terminal` に options を渡し、Terminal は `p.terminal` から取るようにした。claude は自分のセッションの頭になり、PTY が制御端末になる。SIGWINCH はカーネルが前面のプロセスグループに送る。claude が前面で動かす子にも届く。

`p.kill("SIGWINCH")` を送る案は取らなかった。届くのは claude の pid だけで、claude が前面で動かす子には届かない。制御端末が無いままなので、`/dev/tty` を開く子も失敗する。直す前の形では `: < /dev/tty` が失敗し、直した後の形では成功した（macOS の bun 1.3.11）。

## 試験

`test/engine/pty-spawn.test.ts` を足した。偽物ではなく `bunPtySpawn` そのものを使う。

- resize の後、子の WINCH の trap が新しい大きさを読む。
- 子が前面で動かすプロセスにも WINCH が届く。
- 子は自分のプロセスグループの頭で、TTY が `??` ではない。

直す前のコードでは3件とも落ち、直した後は通った（macOS の bun 1.3.11）。Linux（bun 1.4.4）でも、この3件と `pty-driver.test.ts` の20件が通った。

## 止め方への影響

claude はノードのプロセスグループから外れる。試験用のノードで次を確かめた。

- ノードに SIGTERM を送ると、`stopPtysOnExit` が claude を止めた。5秒後には、claude もノードもいなかった。
- ノードに SIGKILL を送ると、直した後の版では、待機中の claude が2秒以内に終わった。直す前の版では、6秒後には残っていて、10秒後には終わっていた。
- 直す前の版では、PTY の子を SIGKILL すると、その子が前面で動かしていたプロセスが残った。直した後の版では残らなかった（`pty-spawn.test.ts` の2件目の後に `pgrep` で確認）。

## 確かめていないこと

- Linux での本物の claude の描き直し。Linux では素の Bun の台本と試験だけを回した。
- 作業中（ターンの途中）の claude で、ノードを SIGKILL したときの振る舞い。
- 本番の3台への配布。
