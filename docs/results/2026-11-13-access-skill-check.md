# Access の認証とスキル void-auth-cloudflare-access の照合（#2、2026-11-13）

ccn の認証を、スキル `void-auth-cloudflare-access`（`~/.agents/skills/void-auth-cloudflare-access/SKILL.md`）の方針と照らした。Access のアプリ、ポリシー、トークンの設定は変えていない。本番の設定は `cf zero-trust access applications list` で読んだだけである。

## 前提

- ccn は Void のアプリではない。各機械の Bun のプロセスを cloudflared のトンネルで出している。スキルの配置の分類では「自前の origin を Tunnel で出す」にあたる。Access 側の手順はスキルと同じで、JWT の検証は `src/identity/access.ts` が行う。
- スキルの Void に固有の部分（`void.config.ts`、`void deploy` の readiness、確認用のサービストークン、`/__void/*`）は対象にしない。

## 本番の Access の設定（2026-11-13 に読んだもの）

| アプリ | ホスト名 | ポリシー | Managed OAuth |
| --- | --- | --- | --- |
| `ccn` | `ccn-*.fybe.jp`、`ccn.fybe.jp` | `owner`（allow、`{"email":{"email":"<本人>"}}`）、`nodes`（non_identity、`{"service_token":{"token_id":"<id>"}}`） | 有効。動的なクライアント登録が有効で、localhost と loopback を許す。access token は15分、grant は336時間 |
| `ccn-install` | `ccn-*.fybe.jp/install`、`ccn-*.fybe.jp/skill.md`、`ccn.fybe.jp/install`、`ccn.fybe.jp/skill.md` | `public`（bypass、`{"everyone":{}}`） | 無し |

## 合っている点

- 認証の正本は Access である。ノードにはユーザーの DB も許可リストも無い。人を通す規則は、Access のポリシー `owner` の email だけにある。
- JWT は `Cf-Access-Jwt-Assertion` を先に見る。無いときだけ cookie の `CF_Authorization` を見て、同じ検証をする。検証するのは、RS256 の署名、`kid` が未知のときの公開鍵の取り直し（1回）、`aud`、`iss`、`exp` である。スキルは cookie だけを見ることを禁じているが、ccn はヘッダを先に見るので当たらない。
- 認証のためだけの依存（Redis、Postgres、別の IdP、oauth2-proxy）は無い。JWT の検証も WebCrypto で書いてあり、`jose` も使っていない。スキルの参照節が挙げる依存ゼロの実装例と同じ形である。
- 誰を通すかを、ノードの側に二重に持っていない。サービストークンの JWT は `common_name` を見るだけで、トークンの id とは照らさない。通すトークンを決めているのは Access のポリシー `nodes` である。

## 違う点と決めたこと

### 1. ブラウザ以外の呼び手

スキルは、CLI やエージェントに Managed OAuth を使うと決めている。ccn は、CLI の `ccn`、MCP の口、中継を、ノード用のサービストークンで通している。

決めたこと：両方を残す。

- ノードどうしの中継、親の Claude が CLI で子を動かす呼び出しは、サービストークンのままにする。どれも人がその場でログインしない機械どうしの呼び出しで、ブラウザでのログインを挟めない。
- 人が外の MCP クライアント（claude.ai のコネクタなど）からつなぐときは Managed OAuth を使う。本番の `ccn` アプリでは既に有効になっている。
- Managed OAuth を有効にした同じアプリで、サービストークンの要求も通っている。2026-11-11 に、4つのホスト名すべてでサービストークンの `/api/host` が200、未認証の `POST /mcp` が401（`www-authenticate: Bearer realm="OAuth"`）だった（`docs/results/2026-11-11-ccn-legacy-off.md`）。今日も、未認証の `GET https://ccn.fybe.jp/api/host` は401だった。スキルの要確認「Managed OAuth を有効にした同じアプリで、サービストークンの要求が通るか」は、ccn の構成では通ると言える。
- Managed OAuth でブラウザのログインを通してからつなぐ道は、まだ本番で試していない（`skills/claude-code-nodes/SKILL.md` にも書いてある）。

### 2. 中継での呼び手の運び方

スキルは、下流へ JWT を `Cf-Access-Token` で転送し、下流の Access に Linked App Token のポリシーを置く。ccn は、入口のノードが自分のサービストークンで相手のノードを呼び、元の呼び手を `x-ccn-from` と `x-ccn-via` で運ぶ（設計の 2.1、2.3）。相手のノードは、JWT がノード用のサービストークンのときだけ、このヘッダを信じる。

決めたこと：今の方式のままにする。Linked App Token は試さない。理由は3つある。

- 運ぶ呼び手の多くは `agent:<ノード>/<sid8>/<役割>` の名乗りで、Access の JWT には入らない。名乗りは、サービストークンか同じ機械から来た呼び手が `as` で付けるものである。Linked App Token に替えても、名乗りを運ぶヘッダとそれを信じる規則は残る。
- Access のアプリは1つで、すべてのノードが同じ aud を持つ。Linked App Token は「上流のアプリ」を値に取るポリシーを下流のアプリに置くもので、同じアプリを自分に結ぶ形が通るかは、ドキュメントからは分からない。
- 試すには、本番の `ccn` アプリにポリシーを足す必要がある。今回の範囲では Access の設定を変えない。

今の方式の弱い点は、ノード用のサービストークンが漏れると、任意の呼び手を名乗れることである。トークンは全ノードで1本を共有している（設計の第2部の決定）。漏れたときは roll して参加をやり直す。この扱いは変えない。

### 3. 認証なしで公開している道

スキルは「Access を付けずに公開しない」とする。ccn は、Bypass のアプリ `ccn-install` で、`/install`、`/install/ccn.tar.gz`、`/skill.md` を認証なしで出している。今日の確認では、`https://ccn.fybe.jp/install` と `/install/ccn.tar.gz` と `/skill.md` は200、`/api/host` は401だった。

決めたこと：例外として残し、何を出しているかをここに書く。

- `/install` はインストーラの sh である。秘密は入っていない。参加トークンは、インストーラが `/dev/tty` から1回読む（設計の 2.6）。
- `/install/ccn.tar.gz` は実行物で、`src`、`skills`、`bin`、`package.json`、`bun.lock`、`tsconfig.json`、`README.md` の tar である（`src/join/bundle.ts`）。private のリポジトリのソースが、誰でも読める状態になっている。秘密はリポジトリに入れない決まりなので、漏れるのはコードだけである。
- `/skill.md` は MCP でのつなぎ方の説明である。

`/install/ccn.tar.gz` をノード用のサービストークンで守る案はある。インストーラは実行物を取る前に参加トークンを読んでいる（`src/join/installer.ts`）。ただし、参加トークンを開くのは実行物の中の bun なので、sh の側でサービストークンを取り出す処理が要る。`ccn update` も同じ道を認証なしで取っている（`src/cli/join-commands.ts`）ので、設定のサービストークンを付ける変更が要る。今回は決めず、確認事項として残す。

## 未確認

- JWT の `nbf` を見ていない。Access の JWT に `nbf` が入っているかは確かめていない。入っていても、`exp` を見ているので期限切れは断れる。
- Managed OAuth でブラウザのログインを通す道は本番で試していない。
- Linked App Token を同じアプリに結ぶ形が通るか。

## スキルへの還元（スキルは直していない。直す案）

- 手順2の「Emails と Service Token の形は API ドキュメントで確認してから書く」は、`{"email":{"email":"<addr>"}}` と `{"service_token":{"token_id":"<id>"}}` が本番で動いている。bypass の `{"everyone":{}}` も同じ。この3つを手順2に書き、要確認から外せる。ccn の `src/join/cf.ts` がこの形で `cf zero-trust access applications create` と `update` に渡している。
- 要確認の「Managed OAuth を有効にした同じアプリで、サービストークンによる readiness が通るか」は、Void の readiness ではないが、同じアプリでサービストークンの要求が通ることを ccn で確かめた。根拠として本節の1を足せる。
- `applications update` は全文の PUT なので、ダッシュボードで入れた `oauth_configuration` を一覧の応答から引き継がないと消える。ccn は引き継いでいる（`src/join/cf.ts` の `ensureApp`）。スキルの手順4の API の説明に、この注意を足せる。
