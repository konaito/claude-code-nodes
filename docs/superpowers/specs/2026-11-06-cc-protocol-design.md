# cc.fybe.jpをプロトコルとアプリケーションに分けて設計し直す（企画）

2026-11-06。対象はkonaito/online-claudecodeの書き直し。実装先は`~/Documents/cc-web`（`/private/tmp/cc-web`で始め、2026-11-06に移した）。

## 何のためか

konaitoは複数の機械（Mac 2台とOrbStackのUbuntu VM）でClaude Codeを動かす。cc.fybe.jpは、それらのセッションを外から一覧し、読み、文を送り、別のClaudeセッション（親）が子を動かすための仕組み。

今の実装はClaude Codeの非公開の内部（`claude agents --json`、transcriptのjsonl、`/tmp/cc-socks/<pid>.sock`、tmux）に依存し、ハブ（Worker）とノード（Mac）で役割が違い、ノードの一覧をWorkerに焼き込み、配布はSSHで押し込む。Claude Codeの更新で壊れ、新しい機械を足すたびに4か所を直す。

書き直しでは2つに分けて定義し直す。

- プロトコル。あるパソコンの中のClaude CodeがAPI的に開放され、操作されることができる。1台で完結し、Cloudflareに依存しない。
- アプリケーション。同一パソコンを超えたClaude Codeのオーケストレーションと、Claude Codeセッションのweb/online管理。プロトコルの上に、認証、登録簿、中継、参加、画面を足す。

どの機械でも同じ1つのプログラム（ノード）がこの両方を担う。ノードはClaude Codeを公式のプロトコルで包み、Cloudflare Accessの裏だけで待ち、自分の保存を持たず、ブラウザにもCLIにも別のClaudeセッションにも同じAPIを出す。

これで新しくできること。

- 呼び手がAccessで認証されるので、親からの文は子のClaudeに「ユーザーの発言」として届く。今の「別セッションからのメッセージ」扱いとchild.mdの制限は、ソケット経路に権限の裏付けが無かったための規則で、要らなくなる。
- 親（人でもClaudeでも）が子の権限プロンプトにAPIで答えられる。今は答えられない。
- セッションをAPIで作れる。cwd、初回の文、権限モード、モデル、再開元を指定できる。
- Claude Codeの更新で壊れる場所が、公式プロトコル（stream-json、control_request、Agent SDK）だけになる。

## 決まっていること（konaitoが決めた）

- 設計で最も大事な点はNonDB。
- 親サーバと子サーバに違いはない。
- 最も単純な形で書き直す。プロトコル単位で再実装する。
- アクセスはCloudflare Access経由。
- Claudeは完全にAPI経由で操作する。
- プロトコルとアプリケーションの2つに分ける（上の定義）。
- SOLID。責務を分け、境界で差し替えられるようにする、と読む。

## 言葉

- ノード。Claude Codeがログイン済みの機械で動く1つのプログラム。全部同じコード。
- セッション。Claude Codeの1つの会話。正本はClaude Code自身のjsonl。
- クライアント。ノードのAPIを呼ぶもの。人のブラウザ、CLI、別のノード上のClaudeセッション（親）。
- 呼び手。クライアントの正体。人はemail、エージェントは`agent:<名前>`。
- 登録簿。ノードの一覧。Cloudflareのトンネル一覧をそのまま使う。
- 入口。cc.fybe.jpが指すノード。DNSのCNAMEをそのノードのトンネルに向ける。替えるときはDNSを1件変える。

## 全体の形

```
[アプリケーション]  ブラウザ / 親の Claude / CLI
        |  Cloudflare Access（email か サービストークン）
        v
  <name>.cc.fybe.jp --(tunnel)--> ノード ==(/n/:peer 中継)==> 別のノード
        |                              ^
        |                              |  CF API（読み取り）: トンネル一覧 = 登録簿
[プロトコル]  127.0.0.1:4322  HTTP+SSE  x-cc-from
        v
  claude -p --input-format stream-json --output-format stream-json --permission-prompt-tool stdio
```

## 第1部 プロトコル（1台の中。Cloudflareに依存しない）

### 1.1 エンジン結合（ノードとClaude Code）

- 正体はClaude Codeの公式プロトコル。`claude -p --input-format stream-json --output-format stream-json --verbose --permission-prompt-tool stdio`。1プロセス1セッションで、stdinにuser行を書き、stdoutのJSON行を読む。プロセスはstdinを閉じるまで生き、多ターンできる（Macの2.1.318で実測）。
- 権限は、CLIがstdoutに`control_request`（subtypeがcan_use_tool。tool_name、input、tool_use_id、permission_suggestions）を出し、ノードがstdinに`control_response`（allowかdeny）を返す。中断は`control_request`のsubtype interrupt。保留中の承認は初期化応答の`pending_permission_requests`で分かる。
- 実装はAgent SDK（`@anthropic-ai/claude-agent-sdk`。CLIと同じ版0.3.318）で包む。`query()`に非同期の入力を渡し、`canUseTool`で承認待ちをPromiseのまま保留し、`listSessions`と`getSessionMessages`で過去を読む。BunとOAuth（APIキー無し）で動くことをMacで確かめた。VMのLinuxでは未確認で、最初の試作で確かめる。
- エンジンはinterfaceの裏に置き、素のstream-jsonの実装と差し替えられるようにする。SDKの内部変更を吸収する境界がここ。
- セッションの種類は2つ。ノード起動（上のstream-json。完全制御）と、端末（人が`claude`で起動した対話式）。
- 端末セッションの一覧は`claude agents --json`（公式。kind、pid、status、waitingFor、sessionId、cwd）。履歴はSDKの`getSessionMessages`。注入は受信ソケット`/tmp/cc-socks/<pid>.sock`に1行書く。これは公式のcross-session-messagingの文書に「スクリプトやhookからセッションに投稿したいときに読む節」として載っている入口で、ソケットはOSユーザーだけに制限される。行の形`{"type":"user","message":{"role":"user","content":"..."}}`は文書に無いが、2026-11-06にこのMac（2.1.318）でncから自分のセッションに書いて届くことを確かめた。
- 端末セッションの制限。届いた文は「別セッションからのメッセージ」として扱われ、権限応答、スラッシュコマンド、設定変更はできない。受信側がbypassのときは`crossSessionInbound: accept`が無いと保留され、5分でダイアログごと捨てられる。参加時にこの設定を入れる。
- 端末セッションの権限応答が要るなら、Channels（公式。MCPサーバーからの注入と権限中継）が道になる。自作channelは`--dangerously-load-development-channels`と起動時の警告が要るが、Teamの管理者は`allowedChannelPlugins`で許可できる（konaitoのアカウントはFYBEのClaude Teamのowner）。起動に`--channels`が要るので運用が変わる。別の企画にする。
- 過去のセッションはSDKの`listSessions`から出す。
- ノードが起動するセッションは、端末の`claude`と同じく利用者・プロジェクト・ローカルの設定（CLAUDE.md、スキル、MCP、hooks、許可規則）を読む。SDKのsettingSourcesを全部渡す。
- 使わないもの。`claude --bg`（stdinでも権限でも操作できない）、tmux、Remote Control（claude.ai経由で自作ページから繋げない）。
- 注意。`--bare`はOAuthを読まないので付けない。2.1.302以降`-p`の既定はmanualで、承認者がいなければ拒否になる。

### 1.2 公開API（クライアントとノード）

形式はHTTPとJSON。流れるものはSSE。待ち受けは127.0.0.1だけ。

監視のAPI。

| パス | 返すもの |
| --- | --- |
| GET /api/host | ノード名、claudeの版、アカウント、レート枠の残り（rate_limit_eventから）、許可するcwd、負荷 |
| GET /api/sessions?parent= | 動いているものと過去のもの。id、kind（node、terminal）、能力（send、permissions、interrupt）、cwd、状態（running、waiting_permission、idle、exited）、開始と最終更新、モデル、権限モード、使用量、parent（最初の文のfrom行から。無ければ無し）。`parent=`で絞れる |
| GET /api/sessions/:id | 詳細と、保留中の承認 |
| GET /api/sessions/:id/messages?after= | 会話。過去はgetSessionMessagesから |
| GET /api/sessions/:id/events | SSE。エンジンのイベントをそのまま（init、assistant、userのtool_result、stream_event、permission_request、result） |
| GET /api/events | SSE。全セッションの状態変化 |

管理のAPI。

| パス | すること |
| --- | --- |
| POST /api/sessions | 作る。cwd、prompt、permissionMode、model、resume、fork、settingSources、mcp |
| POST /api/sessions/:id/messages | 文を送る。nodeはstdin、terminalは受信ソケット |
| POST /api/sessions/:id/permissions/:requestId | allow（updatedInput、updatedPermissions）かdeny（message）。能力permissionsが無いセッションは409 |
| POST /api/sessions/:id/interrupt | 今のターンを止める。能力interruptが無いセッションは409 |
| PATCH /api/sessions/:id | 権限モード、モデルを変える |
| DELETE /api/sessions/:id | プロセスを止める。jsonlは残り、再開できる |

### 1.3 呼び手の表し方

- プロトコルは呼び手を2つのヘッダで受け取る。`x-cc-from`（emailか`agent:<名前>`）と`x-cc-via`（経由したノード名）。無ければ呼び手は`local`。
- 子のClaudeに届く文は、本文の前に1行`from <emailかagent:<名前>> via <ノード名>`を付ける。端末セッションでは、その外側にClaude Code自身が「別セッションからのメッセージ」の定型文を付ける。これは変えられない。
- このヘッダを誰が信じてよいかはアプリケーションが決める（2.1と2.3）。プロトコルはAccessを読まない。同じ機械ならcurlがこのヘッダを直接付けて試せる。

### 1.4 NonDB

- ノードが持つのは、動いているプロセスのメモリと、Claude Codeのjsonlだけ。SSEの途中参加は、過去をjsonlから、現在をプロセスから組み立て、自前のイベントログは持たない。
- ノードを再起動すると動いているセッションは止まり、次の文でresumeする。
- 許可するcwdの根はノードの設定ファイル（cc.json）に書き、既定はホーム。

### 1.5 プロトコルだけの試験

VMの127.0.0.1に立て、curlで作る、送る、SSEで読む、承認する、中断する、止める、再開する、を一通り通す。Cloudflareは要らない。

## 第2部 アプリケーション（複数台をまたぐオーケストレーションとweb/online管理）

### 2.1 認証

- 呼び手の正体はAccessの`Cf-Access-Jwt-Assertion`からだけ取る。人はemail、エージェントはサービストークンのcommon_name。本文のfromは信じない。ノードはaud、iss、期限を検証する。
- 1.3のヘッダを信じる規則は1つ。JWTがemailなら、ノードが`x-cc-from`を自分で置き、外から来たヘッダは捨てる。JWTがノード用サービストークンなら、外から来た`x-cc-from`と`x-cc-via`をそのまま受け取る（中継元のノードが置いたもの）。JWTが無い呼び出しは127.0.0.1からしか届かず、ヘッダをそのまま使う（同じ機械での試験用）。
- Accessアプリは1つ。`cc.fybe.jp`と`*.cc.fybe.jp`を同じアプリに入れ、audを1つにする。方針は2つ。人のemail（ceo@fybe.jp）と、ノード用サービストークン。合言葉（peer-token）は持たない。
- 呼び手ごとの上限は置かない。使うのはkonaitoとkonaitoのエージェントだけで、親は賢い前提（#88で決めた）。

### 2.2 登録簿と入口

- 登録簿はCloudflareのトンネル一覧。名前が`cc-`で始まるトンネルを全部ノードとみなし、URLは`https://<name>.cc.fybe.jp`、状態はhealthyかdown。許可リストは持たない。downも一覧に出す。
- `GET /api/peers`がこれを返す。読むのにCF APIトークン（Tunnel Read）が要る。
- 入口はcc.fybe.jpのCNAMEを向けた1台。今のハブ（Worker）は無くす。サーバーの役割を1つにするため。費用は、常時起動の入口が1台要ること。

### 2.3 中継と呼び手の伝搬

- ブラウザは入口ノードの`/n/:peer/api/...`を呼ぶ。同一オリジンで済ませるため。入口ノードは相手に自分のサービストークンで繋ぎ、元の呼び手を`x-cc-from`と`x-cc-via`で運ぶ。相手のノードは2.1の規則でこのヘッダを受け取る。from行は`from ceo@fybe.jp via konaito-pro`の形になる。
- ブラウザが各ノードを直接呼ぶ案は、Accessのcookieがホスト名ごとで、fetchからはログインできないので取らない。

### 2.4 オーケストレーション（親が子を動かす）

- 親のClaudeセッションは、CLI `cc`で自分のノード（または相手のノード）のAPIを呼ぶ。資格情報はそのノードのcc.json（ノード用サービストークン）をCLIが読む。
- 子を立てるのは相手ノードへの`POST /api/sessions`。文を送るのは`POST .../messages`。返事を待つのはSSEか`GET .../messages?after=`。子の権限プロンプトには`POST .../permissions/:requestId`で答える。
- 親が名乗る名前はasで受け、`agent:<名前>`にする。JWTのcommon_nameは併記する。
- 親子の関係は子だけが持つ（子認識）。子の最初の文のfrom行`from agent:<親の名前> via <ノード>`が親で、SDKの`listSessions`が返す`firstPrompt`から読める。親は自分の子を覚えず、ノードも覚えない。「自分の子」は`GET /api/sessions?parent=agent:<名前>`の絞り込みで毎回導く。親と子の差分は、セッションに`parent`があるか無いかだけで、プロトコルにも実装にも親用の経路は無い。
- 新しいCLIは`cc`で、`inbox`は廃止する。スキルsession-inboxとchild.mdは新APIに合わせて書き直す。並行運用は置かず、既存2ノードを入れ直す日に切り替える。

### 2.5 web/online管理（画面）

- どのノードも`/`で同じ1枚のHTMLを配る。状態はブラウザのlocalStorageだけ。
- 画面は、登録簿（ノードと状態）、各ノードのセッション一覧、会話、送信、承認と拒否、中断、作成、再開、停止を出す。
- 中身は1.2と2.3のAPIを呼ぶだけで、画面専用のAPIは作らない。

### 2.6 参加（新しい機械がノードになる）

接続因子は6つ。道（トンネル）、門（Access）、名、登録簿、実行物、持ち主の鍵（Claudeのログイン）。

人が運ぶのは参加トークン1本。中身は、トンネルトークン、ノード用サービストークン（client_idとsecret）、登録簿の読み取りトークン（CF API、Tunnel Read）、名前、team domain、aud、入口のURL。秘密3つを1本にまとめる。

1. 配る側（cfにログイン済みのMac）で`cc node add <name>`を実行する。cfでリモート管理のトンネル`cc-<name>`を作り（`cf tunnels create`）、ingressを`<name>.cc.fybe.jp`から`http://127.0.0.1:4322`に向け（`cf tunnels config update`）、DNSのCNAMEを作り（`cf dns records create`）、トンネルトークンを取る（`cf tunnels token get`）。参加トークンは端末にだけ出す。pbcopyがあればクリップボードに入れ、表示しない。
2. 新しい機械で`curl -fsSL <インストーラのURL> | sh`を実行する。インストーラは参加トークンを`/dev/tty`から1回読む。引数と環境変数にはしない（シェル履歴とpsに残さないため）。bunとcloudflaredが無ければ入れ、実行物を取り、`~/.config/cc/`に書き、常駐を入れる。macOSはLaunchAgent、Linuxはsystemd --userで`cloudflared tunnel run --token-file`を動かす。Linuxの`cloudflared service install`はrootのシステムサービスなので使わない。
3. 人がその機械で1回`claude`を起動してログインする。済んでいれば不要。この鍵は配らない。
4. 他のノードは何もしない。登録簿はトンネル一覧なので、次の一覧から見える。

1回だけの準備。Accessアプリ1つ（2.1）、ノード用サービストークン1つ、CF APIトークン1つ（Tunnel Read）、cc.fybe.jpのCNAMEを入口ノードのトンネルへ。

外すときは`cc node remove <name>`でトンネルとDNSを消す。機械側は`cc uninstall`。更新は`cc update`で実行物を取り直して再起動する。

確かめた事実。Accessのワイルドカードは1階層だけに効く（https://developers.cloudflare.com/cloudflare-one/access-controls/policies/app-paths/）。fybe.jpのゾーンには`cc.fybe.jp`と`*.cc.fybe.jp`を含むAdvanced証明書パックが既にあり有効なので、`<name>.cc.fybe.jp`の2階層でもTLSは出る（cfで確認）。cloudflared 2026.10.3に`tunnel run --token-file`がある。cfに`tunnels create`、`tunnels token get`、`tunnels config update`、`dns records create`、`zero-trust access applications update`、`service-tokens refresh`がある。VMはsystemd --userとlingerが有効。VMで`claude -p --output-format stream-json`がagent@fybe.jpのOAuthで動いた。

## ノードの設計思想（SOLID）

ノードは「この機械のClaude Codeを、認証された呼び手に、同じAPIで開放する」ためだけの、状態を持たない変換器である。コードの部品より先に、ノードそのものをSOLIDで定める。

- S（単一責任）。ノードの責務は上の1つだけ。会話の正本はClaude Codeのjsonl、仲間の正本はCloudflareのトンネル一覧、画面の状態はブラウザが持つ。ノードはどれも持たないので、いつ止めても、いつ入れ直しても何も失わない。NonDBはこの原則の帰結。
- O（開放閉鎖）。セッションの種類（nodeとterminal。後でChannels）、呼び手の出どころ（Access。後で別のIdP）、登録簿（Cloudflare。後で別の場所）を足すとき、既存のAPIと部品は変えず、実装を1つ足す。APIは種類ではなく能力を見るので、能力が増えてもAPIは閉じたまま。
- L（置換）。どのノードも同じ契約を守るので、入口、中継元、中継先、親の居場所、子の居場所のどの役にも置ける。「親サーバと子サーバに違いはない」はこの原則。入口はDNSが指しているだけで、ノードの側に入口用のコードは無い。
- I（インターフェース分離）。APIは監視（読む）、管理（動かす）、中継、参加の4つに分かれ、クライアントは要るものだけ使う。画面は監視と管理、親のClaudeは管理、インストーラは参加だけを使う。セッションの能力（send、permissions、interrupt）も同じ考えで、呼び手は無い能力を呼ばない。
- D（依存逆転）。ノードはClaude Codeの公式プロトコル、AccessのJWT、CloudflareのAPIという外側に、境界（Driver、Identity、Registry）を通してだけ依存する。境界の内側はClaude CodeもCloudflareも無しに、偽物の実装で試験できる。

## コードの形（SOLID）

1つのプログラムだが、責務ごとに分け、境界はinterfaceにする。組み立て（どの実装を使うか）は起動時の1か所だけで行う。

| 部品 | 責務 | 境界 | 実装 |
| --- | --- | --- | --- |
| engine | 1つのセッションを動かす | Driver（能力の申告、send、events、permissions、interrupt、stop） | NodeDriver（SDK）、TerminalDriver（ソケット）。後でChannelDriver |
| sessions | 動いているセッションの台帳（メモリ）と、過去との合成 | SessionStore | 本物と、試験用の偽物 |
| identity | 呼び手を決める | Identity（requestから呼び手） | AccessIdentity（JWT）、HeaderIdentity（127.0.0.1の試験用） |
| registry | 仲間の一覧 | Registry（peers） | CloudflareRegistry、StaticRegistry（試験用） |
| relay | `/n/:peer`の中継と呼び手の伝搬 | | |
| api | HTTPとSSE。上の境界だけを見る | | |
| join | `cc` CLI（node add、node remove、update、uninstall）とインストーラ | | |
| web | 1枚のHTML | | |

- S。各部品は1つの理由でしか変わらない。SDKが変わればengineだけ、Cloudflareが変わればregistryとidentityだけ。
- O。セッションの種類を増やすときはDriverを足すだけで、apiは能力を見て振る舞う。
- L。どのDriverもDriverの契約（能力の申告を含む）を守る。能力に無い操作は呼ばれない。
- I。apiはDriverを小さなinterface（Sendable、Permissionable、Interruptible）に分けて使う。
- D。apiとrelayは実装ではなく境界に依存する。試験は偽物の実装で、Cloudflareもclaudeも無しに通る。

## 誰が何を持つか

| 場所 | 秘密 | 公開値 |
| --- | --- | --- |
| Cloudflare | トンネルの秘密、Accessの方針、サービストークンの秘密 | トンネル一覧（登録簿）、DNS、aud |
| ノード | トンネルトークン、ノード用サービストークン、CF API読み取りトークン、Claudeのログイン | cc.json（名前、team domain、aud、入口のURL、許可するcwdの根） |
| 配る人 | cfのログイン | 参加トークン（1回きり。貼り終えたら捨てる） |
| ブラウザ | Accessのcookie | localStorage |

## やらないこと

- Claudeのログインを配ること。`~/.claude/.credentials.json`は機械ごとに人が作る。
- ノードの一覧、状態、イベントの自前保存。
- 端末セッションの権限応答と中断。ソケットでは届かない。Channelsで足す企画は別にする。
- Worker。
- 複数ユーザー。使うのはkonaitoとkonaitoのエージェントだけ。
- 画面専用のAPI。

## 失敗とみなすこと

- Claude Codeの非公開の内部（jsonlの直接解析、tmux、バイナリから読んだ文言）に依存すること。jsonlはSDKの関数からだけ読む。受信ソケットは公式に「スクリプトから投稿してよい」と書かれた入口なので例外とし、行の形だけが非公開なので、ノードは起動時に自分宛ての試験用セッションに1行送って疎通を確かめる。
- プロトコルがCloudflare無しで試せないこと。
- ノードごとにコードや役割が違うこと。
- 新しいノードを足すのに、他のノードやAccessを編集すること。
- 秘密がシェル履歴、ps、リポジトリ、ログに残ること。
- 親の文が子のClaudeに「権限の無い相手」として届くこと。

## 試作の順（確かめたいことの順）

1. VMでSDKをBunで動かし、OAuthで1ターン、権限の保留と承認、中断、再開が通るか（1.1）。
2. プロトコルのAPIをVMの127.0.0.1に立て、curlで一通り通す（1.5）。
3. VMをトンネルとAccessで出し、ブラウザとcurl（サービストークン）で同じことを外から通す（2.1、2.2）。
4. 参加トークンとインストーラで2台目（incertotechかMac）を足し、中継と親からの呼び出しを通す（2.3、2.4、2.6）。
5. 画面（2.5）。

## 確認事項

決まったこと（2026-11-06。本人の「外から注入したい」「クールな方法で、SOLIDに」を受けて、こちらが選んだ。違えば直す）。

1. 端末の対話式`claude`にも外から注入する。方式は受信ソケット（1.1）。tmuxで起動し直す案は取らない。根拠は、公式に書かれた入口であること、このMacで届いたこと、運用の変更が無いこと。
2. APIは種類（node、terminal）ではなく、セッションが申告する能力（send、permissions、interrupt）で応答を決める。後でChannelsを足したときに、terminalの能力が増えるだけで済む。
3. ハブ（Worker）は無くす。
4. 入口ノードは、試作の間はVM、移行後はincertotech（常時起動）。切り替えはcc.fybe.jpのCNAMEを1件変えるだけ。
5. 既存2ノード（konaito-pro、incertotech）は移行の日に新方式で入れ直し、名前は維持し、旧実装（Worker、launchd、deploy-node.sh）は止める。
6. インストーラと実行物は入口ノードの`/install`から配る。Accessで`cc.fybe.jp/install`だけをBypassにする。ノードは自分の実行物を配れるので、GitHubの資格情報もWorkerも要らない。

未確認のこと。

6. 規約。SDKのoverviewに「事前承認が無い限り、第三者開発者がclaude.aiログインやレート上限を自分の製品で提供することは認めない」とある。自分のサブスクで自分だけが使う個人ツールは対象外と読めるが未確認。設計全体がサーバー内のOAuthに乗るので、ここが崩れるとAPIキー運用になる。
7. SDKがVMのLinuxとBunで動くか。Macでは確認済み。
8. CF APIでトンネル一覧を読む応答時間。遅ければ数十秒のメモリキャッシュを置く。
9. `cc.fybe.jp/install`をBypassにするとき、パス付きのアプリが優先されるか。

## こちらで決めたこと（建てる人の確認に答えたもの。違えば直す）

- 中継の呼び手は`x-cc-from`と`x-cc-via`で運び、ノード用サービストークンのJWTのときだけ信じる（2.3）。
- ノードが起動する子は端末と同じ設定を読む。`POST /api/sessions`でsettingSourcesとMCPを上書きできる（1.1、1.2）。
- 呼び手ごとの上限は置かない。親の文が「ユーザーの発言」として届いても、設定・権限・公開の操作を人のemailだけに限る規則は置かない。親は賢い前提で、必要になればcc.jsonの規則として足す。許可するcwdの根はcc.json（2.1、1.4）。
- 旧クライアント（inbox CLI、スキル、child.md）の置き換えは今回の範囲（2.4）。
- プロトコルはAccessを読まない。認証はアプリケーションの層でヘッダに変換する（1.3、2.1）。

## 建てる人に任せること

- 参加トークンの形式、設定ファイルの場所、常駐の名前、CLIの引数、イベントの正確なJSON、キャッシュの秒数。
- SSEの途中参加で過去と現在をつなぐ方法。
- 画面の作り。

## 第2部で決めたこと（2026-11-06、本人が「いいよ」で承認）

- Accessアプリは新規に`cc`を作る。ホスト名は`*.cc.fybe.jp`だけ、session 720h、方針はceo@fybe.jpのemail allowと、新しいサービストークン`cc-node`のnon_identity。既存のsession-inboxをcfで直す操作はPUT（全文送り）で、本番の方針を消す危険があるため触らない。移行日に旧2アプリ（session-inbox、session-inbox-nodes）を消してから`cc.fybe.jp`を足し、`cc.fybe.jp/install`のBypassアプリを作る。
- 登録簿を読むCF APIトークン（Cloudflare Tunnel Read、アカウントfybe.jp）は本人がダッシュボードで1回作る。cfのOAuthログインでは`accounts tokens`も`user tokens`も403で作れない（2026-11-06に実測）。トークンは`cc node add`が/dev/ttyで読む。
- ノードの置き場。`~/.config/cc/cc.json`（0600）に公開値（name、port、roots、domain、teamDomain、aud、entry）と秘密3つ（serviceTokenのclientIdとclientSecret、cfApiToken）をまとめる。トンネルトークンは`~/.config/cc/tunnel.token`（0600、cloudflaredの`--token-file`用）。全ノードで同じ1本を共有し、漏れたらrollして参加をやり直す。
- cc CLIの命令。`peers`、`ls [--peer] [--mine]`、`show`、`new <dir> <文> [--peer] [--mode] [--model] [--resume]`、`send`、`read [--after] [--wait]`、`run`、`wait`、`allow`、`deny`、`interrupt`、`stop`、`serve`、`node add`、`node remove`、`update`、`uninstall`。対象は`<peer>/<sessionIdの先頭8文字以上>`かsessionId。`--as <役割>`の名乗りは`agent:<ノード名>/<自分のsessionIdの先頭8文字>/<役割>`。CLIは相手ノードを`https://<peer>.<domain>`に直接サービストークンで呼び、入口の中継は通さない。手元のノードは127.0.0.1に無認証で呼ぶ。
- 画面は3段。パソコン一覧（登録簿と各ノードの`/api/host`。本人の追加要望）、選んだパソコンのセッション一覧、選んだセッションの会話。PWA（manifestとsw）はv1に入れない。Markdownは旧画面と同じ自前の最小実装（どちらもこちらの判断）。
- 試作のVMは`vm.cc.fybe.jp`（トンネル`cc-vm`）。順序はAccessアプリ、AccessIdentity（JWTの無い外部を403）、DNSとcloudflaredの順で、DNSを先に向けない。
- 確認事項8の答え。`cf tunnels list`は0.66秒。登録簿のキャッシュは10秒程度のメモリで足りる。
- ノードのホスト名を`<name>.cc.fybe.jp`から`cc-<name>.fybe.jp`（トンネル名と同じ1階層）に変えた（2026-11-06、本人が選んだ）。2階層を覆うAdvanced証明書は旧Workerのカスタムドメインに付いて自動で出ていたもので、Workerを消すと一緒に消え、このアカウントにはAdvanced Certificate Managerが無く作り直せない。1階層ならUniversalの`*.fybe.jp`で覆える。Accessアプリ`cc`は`cc-*.fybe.jp`と`cc.fybe.jp`を覆う。画面の入口`cc.fybe.jp`は変わらない。

## 改名（2026-11-11、本人が承認）

- 製品名を Claude Code Nodes、CLI を `ccn` にそろえた。この文書の `cc`、`cc.json`、`x-cc-from`、`<name>.cc.fybe.jp`、`cc-<name>` は、今の名前では `ccn`、`ccn.json`、`x-ccn-from`、`ccn-<name>.fybe.jp`、`ccn-<name>` にあたる。名前の正本は `src/names.ts`。
- 移行の間、ノードは旧の名前（`x-cc-*` のヘッダ、`/install/cc.tar.gz`、`cc-` で始まるトンネル、`~/.config/cc/cc.json`）も受ける。手順は `docs/runbooks/2026-11-11-ccn-rename.md`。
- スキル session-inbox は `ccn` に改名した。立てる判断は、本人が `/ccn` か「子を立てて」と言ったときだけにし、2.4 の「頼まれなくても子を使う」はやめた。

## MCP の口と /skill.md（2026-11-11、本人が「ノードが /skill.md を公開」「MCP サーバーを足してから書く」を選んだ）

- どのノードも `/mcp` で MCP サーバーを出す。トランスポートは Streamable HTTP で、状態を持たない（`Mcp-Session-Id` を出さない）。応答は JSON 1回で、GET と DELETE は 405 を返す。NonDB の帰結で、ノードは MCP のセッションも持たない。
- 実装は公式 SDK `@modelcontextprotocol/sdk` 1.32.2 の `WebStandardStreamableHTTPServerTransport`。Web 標準の Request と Response で動くので、Bun にそのまま載る。agent-sdk の peer として既に入っていた版なので、依存は増えない。v2（`@modelcontextprotocol/server` 2.4.0、仕様 2026-07-28）も手元の Claude Code 2.1.322 で動いたが、依存が増えるので今回は取らない。
- ツールは 1.2 の API と同じ操作で、9つ（list_peers、list_sessions、get_session、create_session、send_message、read_messages、answer_permission、interrupt_session、stop_session）。ツールは中で HTTP の API を、Identity が決めた呼び手のまま呼ぶ。別のノードは `/n/<peer>/api/...` の中継を通るので、from 行、能力の検査、2.1 の規則は API と同じになる。MCP 用の経路はノードの内側に作らない。
- 名乗り（`as`）は、HTTP で `x-ccn-from` を信じる呼び手（ノード用サービストークンと同じ機械）だけに許す。email の呼び手は email のまま。
- 待つツール `read_messages` は最大50秒で返す。Cloudflare は応答の無いまま125秒で524を返し、MCP の TypeScript クライアントの要求の既定の締め切りは60秒なので、その手前にした。続きは cursor で読む。出力は既定2万字で切る。
- 認可は今の Access のまま。同じ機械からは無認証（127.0.0.1）、外からはノード用サービストークン（Claude Code の `headersHelper` でファイルから読む）か、Access の Managed OAuth。Managed OAuth を有効にすると、Access がクライアントに OAuth の認可サーバーとして振る舞い、ノードには今と同じ `Cf-Access-Jwt-Assertion` が届くので、`AccessIdentity` は変えなくてよい。本番で有効にするかは別に決める。
- `/skill.md` は製品の説明と MCP でのつなぎ方を Agent Skills の形（name、description、500行未満）で書いた文書で、認証なしで配る。正本は `skills/claude-code-nodes/SKILL.md`（束に入り、利用者の機械にはリンクしない）。Bypass アプリ `ccn-install` は `<host>/install` と `<host>/skill.md` を外す。2026-11-14 に、PWA の manifest とアイコンを置く `<host>/pwa` も足した（`docs/results/2026-11-14-pwa.md`）。

## 受け口とプロンプト無しの作成（2026-11-11、本人が「ccn 専用の受け口を各ノードに作る」「受け口が対象の場所に子を立てる」を選んだ）

- 新しいセッションは、場所だけを決めて開き、1通目は後から打つ。`POST /api/sessions` は prompt を省ける。prompt も resume も無ければ、ノードが UUID を決めて SDK の `sessionId` に渡す。id はすぐ決まり、`state` は `idle`、要約に `awaitingFirst: true` が付く。1通目は今までの send で届き、from 行もそこで付く。
- 1通目が来るまで claude を起動しない（遅延起動）。待っている claude は1体で約300MB あり、画面の「新しく」は打たずに離れることがあるため。1通も届かないまま30分たったセッションは、台帳の掃除で消す。
- `sessionId` を指定すると、init の `session_id` と jsonl のファイル名が指定した id になる。Bash に渡る `CLAUDE_CODE_SESSION_ID` も同じ id になる。どれも 2026-11-11 に SDK 0.3.318 と claude 2.1.322 で実行して確かめた（記録は `docs/results/2026-11-11-lobby.md`）。
- cwd を省くと受け口に立てる。受け口は設定の `lobby` で、既定は `<home>/.local/share/ccn/lobby`。3台とも roots がホームなので内側に入り、Linux に `~/Documents` が無くても同じ形で作れる。`GET /api/host` は `lobby` を返す。
- 受け口の CLAUDE.md は ccn が持ち、ノードの起動、`ccn install`、`ccn update` のたびに書き直す。本人が足す分は `CLAUDE.local.md` に書く。
- 受け口の `.claude/settings.json` も ccn が持ち、同じときに書き直す。許すのは ccn の peers、places、ls、show、new、run、read、allow、deny、stop だけで、Read は許さない（`Read(//<root>/**)` を許すと、`grep -r`、`rg`、ワイルドカードの `cat` と `head` が deny をすり抜けたため）。deny には、roots とノードのホームの下の秘密の置き場（`.ssh`、`.gnupg`、`.aws`、`.cloudflared`、`.config/ccn`、旧の `.config/cc`、`.config/gh`、`Library/Keychains`、`.netrc`、`.claude/.credentials.json`）と、どこにあっても `.env`、`.env.*`、`*.pem`、`*.key` を入れる。`CCN_CONFIG` で既定の外の設定を読んでいるときは、そのファイルと隣の `tunnel.token` も足す。deny は allow より先に評価され、bypassPermissions でも効く。SDK のセッションは未信頼のフォルダの `.claude/settings.json` の allow を使わないので、ノードは cwd が受け口のセッション（resume を含む）にだけ、同じファイルを SDK の `settings`（CLI の `--settings`）でも渡す。呼び手が本文で渡す `settings` は使わない。本人が足す許可は `.claude/settings.local.json` に書く。
- 受け口の CLAUDE.md の中身は、行き先を roots の中から探すこと、`ccn new <dir> <文> --mode <自分のモード> --as lobby` で子を立てること、返事に `子: <peer>/<sessionId>` を書いてすぐ終えること、行き先は `ccn places` で探し、`ls`、`cat`、`head`、`grep` で探さないこと、行き先を決められなければ AskUserQuestion を使わず文で聞き返すこと、ccn で分かることには子を立てずに答え、ファイルの中身を読む依頼は行き先の子に任せること。
- 受け口は子を CLI で立てる。CLI は Bash の `CLAUDE_CODE_SESSION_ID` から名乗りを組むので、子の `parent` が受け口になり、一覧で親子として並ぶ。MCP で立てると `parent` が `local` になるので使わない。
- MCP に `list_places`（受け口、roots、roots の内側の最近の場所）を足した。ツールは10になった。`create_session` は cwd と prompt を省ける。
- `GET /api/places`（CLI の `ccn places`、MCP の `list_places` の `places`）は、roots の直下と `<root>/Documents` の直下のディレクトリごとに、絶対パス、README の先頭、git の remote の url、最近使った時刻を返す。ノードが読むのは README と git の設定（worktree なら `.git` の1行と `commondir`）だけで、symlink を解いた実体が roots の内側にあり、受け口の deny と同じ秘密の置き場（`src/lobby/lobby.ts` の `isSecretPath`）に当たらないものだけを読む。remote の利用者名と token は消す。走査は1000ディレクトリ、返すのは既定60件（最大300件）、JSON は16,000字までで、走査の結果は終わってから10秒覚える。macOS では、ホームの直下の保護フォルダ（Desktop、Downloads、Library、Pictures、Music、Movies、Public、Applications）と /Volumes を指す symlink に fs を当てない。fs の呼び出しは1回1秒、走査全体は3秒で打ち切り、時間切れのときは読めた分に `partial`、`unreadable`、`note` を付けて返す。1回の上限を超えたパスは、ノードが動いている間は開かない。同時の呼び出しは1つの走査を待つ（`PlacesScanner`）。
- 古い版のノードは cwd か prompt が無いと `cwd is required` か `prompt or resume is required` の 400 で断る。画面、CLI、MCP はこの文言を見て、そのノードが古い版だと伝える。

## 子の深さの上限（2026-11-13、本人が「孫までしかできないようにして欲しい」と言った）

- 人が立てたセッション（呼び手が email、`local`、sessionId を名乗らない名前）を深さ0、その子を1、孫を2とする。孫からのセッションの作成は、HTTP、MCP、CLI のどれも `POST /api/sessions` の中で 409 で断る。断る文は「孫（深さ2）は子を作れない。仕事は自分でやるか、sub-agent（Agent ツール）を使う」に、呼び手と呼び手の深さを付けたもの。
- 深さはノードが作ったときにメモリに刻む。刻んだ値の無いセッション（端末、過去、ノードの再起動の前）は、呼び手の sessionId の先頭8文字から親をたどる。親は、生きている間の呼び手と最初の文の from 行の呼び手の両方を見て、深いほうを取る。resume と fork（人の resume も）は元の深さを引き継ぐ。
- 呼び手が別のノードのセッションなら、中継で `GET /api/depth?session=<先頭8文字>` を聞く。古い版か届かないか見つからないときは断らず、子を深さ1以上として数える。人、Specter、端末のセッションも「見つからない」側に入りうるので、断ると通常の利用が止まるため。
- 受け口のセッションは段に数えない。受け口の子は受け口と同じ深さになる。
- `as_session` を名乗らない呼び手は人と見分けられない。この上限は暴走を止めるためのもので、名乗りを偽る呼び手は止めない。

## 一覧の絞り込み、ETag、変化の SSE（2026-11-13、#24。親の依頼で建てる人が決めた）

- `GET /api/sessions` に `?state=` を足した。値は `live`（exited 以外）か、`running`、`waiting_permission`、`idle`、`exited` のカンマ区切りで、知らない値は 400。exited を含まなければ、終わったセッションの一覧（`listSessions`）を読まない。
- 一覧の応答に、本文のハッシュの `ETag` を付けた。`If-None-Match` が同じなら 304 を本文なしで返す。中継は `If-None-Match` を相手へ、`ETag` を呼び手へ運ぶ。
- 一覧の変化は `GET /api/sessions/stream`（SSE）で流す。`?state=` と `?parent=` は一覧と同じ。イベントは `sessions` の1種類で、data は絞った一覧の全体、`id` はその一覧の ETag。差分ではなく全体にしたのは、受け側が今の一覧の処理をそのまま使えるため。最初に今の一覧を1回流し、Last-Event-ID が今の ETag と同じなら省く。
- 既にある `GET /api/events`（台帳の変化だけ）は変えない。新しい口を別のパスにしたのは、古い版のノードが `/api/sessions/stream` に 404 を返し、受け側がポーリングへ戻る合図にできるため。セッションの id は UUID なので `stream` と重ならない。
- ノードは購読がある間だけ一覧を見張る。台帳（node と pty）の状態の変化は 200ms まとめてすぐ流す。端末のセッションには変化の知らせが無いので、4秒ごとに `claude agents --json` を1回起動し、一覧を作って ETag を比べる。購読が無くなればタイマーも台帳の購読も消す。同じ絞り込みの購読が何本あっても、起動は1本の見張りの分だけ。
- 4秒は、Claude Town が一覧を2秒ごとに呼んでいたときの起動回数（約4秒に1回）と同じにした。`claude agents --json` は1回 CPU 約0.27秒なので、短くすると機械全体の負荷が増える。端末のセッションの状態は、最大で約4秒遅れて届く。
- 見張りが動いている間は、要求の側（一覧と詳細）からは `claude agents --json` を起動せず、見張りが取り直した値を使う。起動は同時に1本だけにする。

## 認証とスキル void-auth-cloudflare-access の照合（2026-11-13、#2。親の依頼で建てる人が決めた）

- 照合の記録は `docs/results/2026-11-13-access-skill-check.md`。Access の設定は変えていない。
- ブラウザ以外の呼び手は、ノードどうしと親の CLI をサービストークン、人が外の MCP クライアントからつなぐときを Managed OAuth にする。両方が同じ Access アプリで通ることは、2026-11-11 に確かめてある。
- 中継の呼び手は、今の `x-ccn-from` と `x-ccn-via` で運ぶ。`agent:` の名乗りは Access の JWT に入らないので、Linked App Token に替えてもこの規則は残る。
- `/install`、`/install/ccn.tar.gz`、`/skill.md` は、Access を付けない例外として残す。実行物の tar にはリポジトリのソースが入り、誰でも読める。サービストークンで守るかは決めていない。
