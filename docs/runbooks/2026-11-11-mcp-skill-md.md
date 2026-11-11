# MCP の口と /skill.md を本番に入れる

対象は PR（feat/mcp-skill-md）のマージ後。3台のノードと Access を順に更新する。各手順の確認が通らなければ、次に進まない。

## 1. ノードを更新する

入口のノードは配布元なので、先に手元の checkout から入れる。ほかのノードは入口から取る。

```bash
# 入口のノード（ccn.fybe.jp の CNAME が向いている機械）で
git -C <checkout> pull
ccn update --from <checkout>
# ほかのノードで
ccn update
```

確認する。

- 各機械で `curl -s http://127.0.0.1:<port>/skill.md | head -3` の1行目が `---`、2行目が `name: claude-code-nodes`。
- 各機械で `curl -s -X POST http://127.0.0.1:<port>/mcp -H 'content-type: application/json' -H 'accept: application/json, text/event-stream' -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"curl","version":"0"}}}'` が `serverInfo` の `name` に `ccn` を返す。

## 2. Bypass に /skill.md を足す

cf にログイン済みの機械（konaito-pro）で、setup をやり直す。Bypass アプリ `ccn-install` の宛先が、ホストごとに `/install` と `/skill.md` の2つになる。Access アプリ、サービストークン、aud は変わらない。

```bash
ccn setup --hosts 'ccn-*.fybe.jp,ccn.fybe.jp,cc-*.fybe.jp,cc.fybe.jp'
```

確認する。

- 出力の aud が `~/.config/ccn/ccn.json` の aud と同じ。違えば止めて調べる。
- `curl -s -o /dev/null -w '%{http_code}\n' https://ccn.fybe.jp/skill.md` が 200。
- `curl -s -o /dev/null -w '%{http_code}\n' https://ccn.fybe.jp/api/host` が 200 以外（302 か 401。Access が効いている）。
- `curl -s -o /dev/null -w '%{http_code}\n' https://ccn.fybe.jp/install` が 200（今までの Bypass が残っている）。

## 3. Claude Code から MCP を足す

ノードのある機械では、手元のノードにつなぐ。秘密は要らない。port は `ccn.json` の `port`。

```bash
claude mcp add --transport http --scope user ccn http://127.0.0.1:<port>/mcp
claude mcp list   # ccn が Connected
```

## 4. Managed OAuth（任意。claude.ai のコネクタから使うとき）

本番の Access アプリ `ccn` で Managed OAuth を有効にすると、未認証の非ブラウザ要求に Access が 401 と OAuth の案内を返し、MCP クライアントはブラウザのログインに進む。ノードには今と同じ JWT が届くので、ノードのコードは変えなくてよい。

- ダッシュボードの Access controls > Applications > `ccn` > Edit > Advanced settings > Managed OAuth を有効にする。手元の CLI を通すなら Allow localhost clients と Allow loopback clients を入れる。
- `ccn setup` は Access アプリを全文で上書きする。一覧の応答に `oauth_configuration` が載っていれば引き継ぐようにしたが、載るかどうかは未確認。setup をやり直したら、ダッシュボードで Managed OAuth が残っているかを見る。

有効にする前に確かめること（未確認）。

- 同じアプリで、サービストークン（ノード間の中継と CLI）が今までどおり通るか。
- OAuth で来た要求の JWT に email が入るか。入らなければ、呼び手は `AccessIdentity` で 403 になる。
- claude.ai のコネクタの redirect URI を Allowed redirect URIs に入れる必要があるか。

戻すときは Managed OAuth を切る。ノードの側は何もしなくてよい。

## 戻す

- ノード: 前の版の checkout から `ccn update --from <checkout>`。
- Bypass: 前の版の `ccn setup` をやり直すと `/skill.md` の宛先が消える。
