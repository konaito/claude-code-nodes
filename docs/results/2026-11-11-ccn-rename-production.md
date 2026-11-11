# cc から ccn への本番の入れ替え（2026-11-11）

`docs/runbooks/2026-11-11-ccn-rename.md` の手順0〜8を、konaito-pro、vm、incertotech の3台で行った記録。作業は konaito-pro の Specter のペイン（ノードが立てたセッションではない端末）から行い、vm には `orb run -m ubuntu`、incertotech には `ssh incertotech` で入った。

## マージ

- PR #8、#9、#10（gh stack #11）を `gh stack merge 11 --merge` で main に入れた。main の先頭は `aa63729`。
- マージの前に、3つの層それぞれで `bun test`（168、178、196 件、0 fail、1 skip）と `bunx tsc --noEmit -p .` を通した。CI は無い。

## 手順書の未確認だった点

| 点 | 結果 | 確かめ方 |
| --- | --- | --- |
| `cf tunnels edit --name` で接続が切れないか | 切れなかった | 改名の前後で `ccn-<name>.fybe.jp/install` を5秒ごとに取り、全部 200。cloudflared のログに改名後の再接続の行が無く、`cf tunnels list` の接続数は3本とも4のまま |
| `ccn setup` の上書きで aud が変わらないか | 変わらなかった | 上書きの前後で `cf zero-trust access applications list` を控えて比べた。`ccn`（旧 `cc`）は `58ac2cb3…66e4`、`ccn-install`（旧 `cc-install`）は `34ea5971…a006` のまま。アプリの id も同じ。方針の id は作り直されたが、中身（owner の email と nodes の service_token）は同じ |
| `ccn-*.fybe.jp/install` の Bypass | 効いた | 3台とも `/install` と `/install/cc.tar.gz` が 200、`/api/host` が 302。`/install/ccn.tar.gz` は、更新前のノード（vm、incertotech）では 404、更新後は 200 |
| launchd の停止がノードの子まで止めるか | 止めた | 手順1の旧の常駐の再起動で、node（pid 1243）の子の claude（pid 30390、ノードが立てた konaito-pro/edc924ca）が消えた |

## 手順書と違ったこと

- `ccn entry incertotech --host ccn.fybe.jp` は ingress の行き先を既定の `127.0.0.1:4322` にした。incertotech のノードは 4323 で待つので、ccn.fybe.jp が 502 を返した。`--port 4323` を付けて出し直し、200 になった。手順書に `--port 4323` を足した。
- 手順3の直後、konaito-pro の `ccn doctor` の外からの API が一度 502 を返した。cloudflared の再接続を待つと 200 になった。
- vm の cloudflared のログは `~/.local/share/ccn/log/tunnel.log` ではなく journald にある（`journalctl --user -u ccn-tunnel`）。
- 束（`ccn.tar.gz`）に macOS の xattr（`com.apple.provenance`）が入っており、Linux の tar が警告を出す。展開は成功する。

## 終わった状態

- 3台とも `ccn doctor` は、claude の版の警告（試験済みは 2.1.318、konaito-pro は 2.1.322、incertotech は 2.1.319）を除いて ok。vm は全部 ok。
- `ccn peers` は3台とも `https://ccn-<name>.fybe.jp` で healthy。
- トンネルは `ccn-konaito-pro`、`ccn-incertotech`、`ccn-vm` に改名した。id は変わらない。
- 常駐は macOS が `jp.fybe.ccn.node` と `jp.fybe.ccn.tunnel`、vm が `ccn-node.service` と `ccn-tunnel.service`。旧の `jp.fybe.cc.*` と `cc-*.service` は無い。
- 3台の設定の入口は `https://ccn.fybe.jp`。
- `https://ccn.fybe.jp/install` は GET で 200。HEAD（`curl -I`）は 405。旧の `https://cc.fybe.jp/install` も GET で 200 を返す。
- `https://ccn.fybe.jp` をブラウザで開くと Access のログイン画面（「Log in to ccn」）になる。サービストークンで取った画面の見出しは「Claude Code Nodes」。`/api/sessions` は 200。

## 残してあるもの

- 旧のホスト名（`cc-<name>.fybe.jp`、`cc.fybe.jp`）の ingress、CNAME、Access のホスト名は残した。片付けは手順書の6に従う。消す時期は決まっていない。
- サービストークンは `cc-node` の名前のまま使っている。
- 各機械の `~/.config/ccn/legacy-cc.json`（konaito-pro だけ）と `~/.config/ccn/legacy-session-inbox-20261111/` は退避の控え。
