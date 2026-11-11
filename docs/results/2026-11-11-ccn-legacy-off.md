# 旧のホスト名（cc.fybe.jp と cc-<name>.fybe.jp）を消した記録

2026-11-11 の14時ごろ（JST）に行った。本人が親の Meta セッションで「今日切り替えよう」と答えたのを受けた。作業は konaito-pro の端末から行い、incertotech には `ssh incertotech`、vm には `orb run -m ubuntu` で入った。手順は `docs/runbooks/2026-11-11-ccn-rename.md` の手順6に書いた。

## 消す前に探したもの

旧名を `rg -nP '(?<![A-Za-z0-9])cc(\.|-[A-Za-z0-9*-]+\.)fybe\.jp'` で探した。

| 機械 | 場所 | 結果 |
| --- | --- | --- |
| 3台 | `~/.config/ccn/ccn.json` | `domain` は `ccn.fybe.jp`、`entry` は `https://ccn.fybe.jp`。直すものは無かった |
| 3台 | `~/.config/ccn/child.md` | 2行目に「移行の間は https://cc.fybe.jp も」がある。正本の `skills/ccn/child.md` も同じ。この PR では直していない |
| konaito-pro | `~/.config/ccn/legacy-cc.json`、`legacy-session-inbox-20261111/` | 退避の控え。ノードは読まない。incertotech と vm にも `legacy-session-inbox-20261111/` がある |
| konaito-pro | `~/.cloudflared/session-inbox.yml` | 改名前の `cc-node-pro.fybe.jp` を持つ古い設定。これを使う cloudflared は動いていない |
| konaito-pro | `~/.claude` の CLAUDE.md、settings、hooks、skills | 無かった。skills はリンク先の `ccn/child.md` だけ |
| konaito-pro | `~/.cam/profiles/*/` の CLAUDE.md と settings、`~/.agents/skills` | 無かった。`~/.agents/skills` はリンク先の `ccn/child.md` だけ |
| incertotech | `~/.claude/CLAUDE.md`、`settings.json`、`hooks` | 無かった |
| vm | `~/.claude/CLAUDE.md`、`settings.json` | 無かった |
| リポジトリ | `src` | `src/config.ts` のコメント2か所だけ |
| リポジトリ | `CLAUDE.md` | 25行目に「入口（cc.fybe.jp）」がある。この PR では直していない |

## 消したもの

| 種類 | 消したもの | 残したもの |
| --- | --- | --- |
| DNS の CNAME | `cc.fybe.jp`、`cc-konaito-pro.fybe.jp`、`cc-incertotech.fybe.jp`、`cc-vm.fybe.jp` | `ccn.fybe.jp` と `ccn-<name>.fybe.jp` の4件 |
| ingress（`ccn-incertotech`） | `cc-incertotech.fybe.jp`、`cc.fybe.jp` | `ccn-incertotech.fybe.jp` と `ccn.fybe.jp`。行き先は `127.0.0.1:4323` |
| ingress（`ccn-konaito-pro`） | `cc-konaito-pro.fybe.jp` | `ccn-konaito-pro.fybe.jp`。行き先は `127.0.0.1:4323` |
| ingress（`ccn-vm`） | `cc-vm.fybe.jp` | `ccn-vm.fybe.jp`。行き先は `127.0.0.1:4322` |
| Access アプリ `ccn` | `cc-*.fybe.jp`、`cc.fybe.jp` | `ccn-*.fybe.jp`、`ccn.fybe.jp` |
| Access アプリ `ccn-install` | `cc-*.fybe.jp` と `cc.fybe.jp` の `/install` と `/skill.md` | `ccn-*.fybe.jp` と `ccn.fybe.jp` の `/install` と `/skill.md` |

DNS は `ccn node remove <name> --legacy` を3回と、`cf dns records delete` で消した。ingress は `cf tunnels config update` で1本ずつ変えた。Access は、旧名が解決されないことを確かめてから `ccn setup --hosts 'ccn-*.fybe.jp,ccn.fybe.jp'` で変えた。setup は `~/.local/share/ccn/app` から動かした。中身は main の `ec596c5` と `diff -rq` で同じだった。

トンネル、サービストークン `cc-node`、Managed OAuth の設定は消していない。

## Access アプリの前後

控えは konaito-pro の `~/.config/ccn/backup-20261111-legacy-off/` に置いた。setup の前後で、アプリを id で `cf zero-trust access applications get` して比べた。`updated_at` と、方針の id と日時は毎回変わるので比べる前に落とした。

| アプリ | aud | oauth_configuration | ほかの差 |
| --- | --- | --- | --- |
| `ccn` | `58ac2cb3…66e4` のまま | 同じ | `destinations` と `self_hosted_domains` から旧名の2件が消えただけ |
| `ccn-install` | `34ea5971…a006` のまま | どちらも無し | `destinations` と `self_hosted_domains` から旧名の4件が消えただけ |

`ccn.json` は setup の前後で同じだった。

## 消した後の確認

curl の結果（前後で同じ）。

| ホスト | `/skill.md` | `/install` | サービストークンの `/api/host` | 未認証の `POST /mcp` | `accept: text/html` の `/api/host` |
| --- | --- | --- | --- | --- | --- |
| `ccn.fybe.jp` | 200 | 200 | 200 | 401 | 302 |
| `ccn-konaito-pro.fybe.jp` | 200 | 200 | 200 | 401 | 302 |
| `ccn-incertotech.fybe.jp` | 200 | 200 | 200 | 401 | 302 |
| `ccn-vm.fybe.jp` | 200 | 200 | 200 | 401 | 302 |

401 には4ホストとも `www-authenticate: Bearer realm="OAuth"` が付いていた。

- `dig +short @1.1.1.1` と、fybe.jp の権威 NS に直接聞いた `dig +short` は、4つの旧名とも空だった。消す前は Cloudflare の IP を返していた。
- konaito-pro の curl は、消した後も旧名で 530 か 404 を返した。macOS のローカルの DNS キャッシュ（`dscacheutil -q host`）が古い IP を持っていたため。上流のリゾルバ（LAN のルーターと ISP の2つ）は空を返した。530 と 404 は Cloudflare の応答で、ノードには届いていない。
- `ccn peers` は3台とも、3つのノードが `https://ccn-<name>.fybe.jp` で healthy だった。
- `ccn doctor` の外からの API は3台とも 200。常駐の node と tunnel は running。
- `cf tunnels list` で `ccn-incertotech`、`ccn-konaito-pro`、`ccn-vm` が healthy。
- konaito-pro の `claude mcp list` で `ccn`（`http://127.0.0.1:4323/mcp`）が Connected。

## 残っていること

- `skills/ccn/child.md` とリポジトリの `CLAUDE.md` の旧名は、CLAUDE.md から読まれる文なので、この PR では直していない。
- claude.ai と agent.meta.ai のコネクタがどのホスト名で登録されているかは確かめていない。`cc.fybe.jp` で登録していれば、`ccn.fybe.jp` で登録し直す必要がある。
- DCR で登録済みの OAuth クライアントが、setup の全文の上書きの後も使えるかは確かめていない。
