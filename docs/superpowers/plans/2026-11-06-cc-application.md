# ccアプリケーション（第2部）実装計画

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 第1部のノードをCloudflare AccessとTunnelで外に出し、登録簿、中継、`cc` CLI、1枚の画面、参加（インストーラと常駐）を足して、VMとMacの2台で外から一通り動かす。

**Architecture:** 同じ1つのBunプロセスに、identity（AccessのJWTを呼び手に変える）、registry（Cloudflareのトンネル一覧）、relay（`/n/:peer`の転送）、web（1枚のHTML）、join（インストーラ、参加トークン、常駐、cfの包み）、cli（`cc`）を足す。Cloudflare（JWKS、CF API、cf CLI）、claude、OSの常駐は境界（Identity、Registry、fetchFn、CfRunner、Runner）の裏に置き、単体試験は偽物で通す。組み立てはmain.tsの1か所だけ。

**Tech Stack:** Bun 1.3系、TypeScript、`@anthropic-ai/claude-agent-sdk@0.3.318`、`bun test`。外部は cf CLI（v1.0.0-beta.12、ceo@fybe.jpでOAuthログイン済み）、cloudflared 2026.10.3、launchd（macOS）、systemd --user（Linux）。

**Spec:** `docs/superpowers/specs/2026-11-06-cc-protocol-design.md`（第2部2.1〜2.6、「ノードの設計思想」「コードの形」「第2部で決めたこと」）。第1部の計画は`docs/superpowers/plans/2026-11-06-cc-protocol.md`。

## Global Constraints

- ブランチは`feat/application`（gh-stackで`feat/protocol`の上。PR #1は未マージ）。`feat/protocol`に手を入れたら`gh stack sync`。mainへ直pushしない。
- ノードのプロセスはファイルを書かない。書くのは`cc`のsetup、install、update、uninstallだけで、書き先は`~/.config/cc/`と`~/.local/share/cc/`と`~/.claude/settings.json`（crossSessionInboundの1キー）と`~/.agents/skills/session-inbox`（リンク）と`~/.config/session-inbox/child.md`。
- 秘密（トンネルトークン、サービストークンのsecret、CF APIトークン、参加トークン）は、argv、環境変数、ログ、console、リポジトリ、試験の固定値に出さない。入力は/dev/ttyか標準入力だけ。`cc.json`と`tunnel.token`は0600。
- 待ち受けは`127.0.0.1`だけ。既定のポートは`4322`。
- APIは能力で振る舞う。能力は`send`、`permissions`、`interrupt`、`stop`、`events`の5つ。無い操作は409。
- 名前。トンネル`cc-<name>`、ホスト名`<name>.cc.fybe.jp`、Accessアプリ`cc`（720h）、Bypassアプリ`cc-install`、サービストークン`cc-node`（8760h）、常駐はmacOS`jp.fybe.cc.node`と`jp.fybe.cc.tunnel`、Linux`cc-node.service`と`cc-tunnel.service`、実行物`~/.local/share/cc/app`、設定`~/.config/cc/cc.json`と`~/.config/cc/tunnel.token`、ログ`~/.local/share/cc/log/`。
- 公開値。domain `cc.fybe.jp`、teamDomain `fybejp.cloudflareaccess.com`、zone `fybe.jp`、accountId `9b67e2ec0e2cf3359289e1fc860d3777`。audは`cc setup`が作ったアプリから取る。
- CLIの実行物の名前は`src/cli/name.ts`の`CLI_NAME`の1か所。macOSの`/usr/bin/cc`（Cコンパイラ）と衝突するので、名前は本人の答えを待つ（既定は`cc`のまま）。
- Cloudflareの操作はcf CLIだけ（cloudflare-cfスキル）。Task 15まで、既存のAccessアプリ（session-inbox、session-inbox-nodes）、トンネル（session-inbox、session-inbox-incerto）、DNS（cc.fybe.jp、cc-node-*）、Worker、サービストークン（session-inbox-*）に触らない。
- 外に出す順。Accessアプリが`*.cc.fybe.jp`を覆う → ノードがAccessIdentityで動く → DNSとcloudflared。DNSを先に向けない。
- 単体試験`bun test`はClaude CodeもCloudflareもネットワークも無しに通る。本物は`CC_LIVE=1`のときだけ。
- 日本語のコメントで、各ファイルの先頭に1行で責務を書く。UIは白ベースのライトテーマ。

## Review Focus

- 人のemailのJWTで来た要求に`x-cc-from: agent:x`が付いている。ノードはヘッダを捨て、emailを呼び手にする（Task 2の試験）。
- Accessが覆っていないホスト名でCloudflareを通って来た（`cf-connecting-ip`はあるがJWTが無い）。ノードは401で断り、localとして扱わない（Task 2の試験）。
- Accessのcookieを持つブラウザから、別サイトのページがPOSTを仕掛ける（Originが違う）。ノードは403で断る（Task 2の試験）。
- 中継先のノードが落ちている、または返事が無い。入口は502と相手の名前を返し、SSEは閉じる。入口が固まらない（Task 4の試験）。
- 参加トークンの末尾に改行が付く、base64が壊れている、項目が欠けている。`cc install`は何も書かずに理由を出して止まる（Task 5とTask 9の試験）。

---

### Task 0: 第1部の残件

**Files:**
- Modify: `src/engine/driver.ts`、`src/engine/node-driver.ts`、`src/engine/terminal-driver.ts`、`src/api/errors.ts`、`src/api/sessions.ts`、`src/sessions/types.ts`、`src/sessions/store.ts`、`src/engine/history.ts`、`test/helpers/fake-driver.ts`
- Test: `test/api/app.test.ts`、`test/engine/node-driver.test.ts`、`test/sessions/store.test.ts`

**Interfaces:**
- Produces:

```ts
// src/sessions/types.ts
export type Capabilities = { send: boolean; permissions: boolean; interrupt: boolean; stop: boolean; events: boolean };
// src/engine/driver.ts（例外をここに集める。errors.ts は具象を import しない）
export class ExitedError extends Error { constructor(reason?: string) }
export class NotFoundError extends Error {}
export class SocketGoneError extends Error { constructor(paths: string[]) }
// src/sessions/store.ts
rateLimit(): unknown | undefined   // 全セッションで最後に流れた type "rate_limit_event" の data
```

- NodeDriverはexitedになったら`capabilities`を全部falseで返す（`readonly`をgetterにする）。TerminalDriverは`{ send: true, permissions: false, interrupt: false, stop: false, events: false }`。Historyは全部false。
- `Sessions.remove`は`driver.capabilities.stop`がfalseなら409（kindを見ない）。`Sessions.events`は台帳に無いか`capabilities.events`がfalseなら409。
- `Sessions.create`はcwdを`fs.promises.realpath`で解いてからrootsと比べる。rootsもrealpathで解く（コンストラクタで1回、失敗した根はそのまま）。
- `host()`は`rateLimit: store.rateLimit()`を足す。
- `Driver.events()`は消費者1つ（台帳）前提であることを`driver.ts`のコメントに書く。

- [ ] **Step 1: 失敗する試験を書く**

```ts
// test/api/app.test.ts に追加
test("DELETE on a session without stop capability is 409", ...);           // FakeDriver stop:false
test("GET events on a session without events capability is 409", ...);
test("POST /api/sessions resolves a symlinked cwd before the roots check", ...); // tmpdir の下に実体、roots 外にリンク → 400。逆は 201
test("GET /api/host carries the last rate_limit_event", ...);              // live.push({type:"rate_limit_event", data:{x:1}}) の後 b.rateLimit.x === 1
// test/engine/node-driver.test.ts に追加
test("capabilities are all false after exit", ...);
```

- [ ] **Step 2: 失敗を確かめる**

Run: `bun test test/api test/engine/node-driver.test.ts`
Expected: FAIL（型エラーと409の不一致）

- [ ] **Step 3: 書く**

例外の移動は`errors.ts`の`import`を`../engine/driver`だけにする。`FakeDriver`のコンストラクタは`capabilities`に`stop`と`events`を受ける（既存の試験は`caps()`ヘルパを5項目にする）。

- [ ] **Step 4: 通ることを確かめる**

Run: `bun test`
Expected: PASS（既存56件と追加分）

- [ ] **Step 5: Commit**

```bash
git add src test && git commit -m "refactor: 境界の例外を driver.ts に集め、能力に stop と events を足す。cwd の realpath と rateLimit"
```

### Task 1: 設定と呼び手の境界

**Files:**
- Modify: `src/config.ts`、`src/identity/identity.ts`、`src/api/app.ts`、`src/api/sessions.ts`、`src/main.ts`
- Test: `test/config.test.ts`、`test/identity/identity.test.ts`、`test/api/app.test.ts`

**Interfaces:**
- Produces:

```ts
// src/config.ts
export type Config = {
  name: string; port: number; roots: string[];
  domain?: string; teamDomain?: string; aud?: string; accountId?: string; zone?: string;
  entry?: string;                                  // 無ければ https://<domain>
  serviceToken?: { clientId: string; clientSecret: string };
  cfApiToken?: string;
};
export function loadConfig(path?: string): Config;
export function saveConfig(cfg: Config, path?: string): void;   // 親ディレクトリを作り、0600 で書く
export function entryOf(cfg: Config): string | undefined;        // entry ?? (domain && `https://${domain}`)
export const APP_VERSION: string;                                // package.json の version
// src/identity/identity.ts
export type CallerKind = "user" | "node" | "local";
export type Caller = { id: string; via?: string; kind?: CallerKind };
export interface Identity { callerOf(req: Request): Promise<Caller> }   // 断るときは AccessDenied を投げる
export class AccessDenied extends Error { constructor(public status: 401 | 403, message: string) }
export class HeaderIdentity implements Identity {}  // 既存の規則。kind は "local"
```

- `app.ts`は`/install`と`/install/*`以外の全経路で先に`identity.callerOf(req)`を1回呼び、`Sessions`の`create(req, caller)`と`send(id, req, caller)`に渡す。`errors.ts`は`AccessDenied`を`e.status`に変える。

- [ ] **Step 1: 失敗する試験を書く**

```ts
test("saveConfig writes 0600 and loadConfig reads it back", ...);     // statSync(p).mode & 0o777 === 0o600、serviceToken も戻る
test("entryOf falls back to https://<domain>", ...);
test("HeaderIdentity is async and marks kind local", ...);
test("app returns the identity's status when it denies", ...);         // identity が AccessDenied(401) を投げる → GET /api/host が 401
```

- [ ] **Step 2: 失敗を確かめる**

Run: `bun test test/config.test.ts test/identity test/api`
Expected: FAIL

- [ ] **Step 3: 書く**

- [ ] **Step 4: 通ることを確かめる**

Run: `bun test`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src test && git commit -m "feat(config,identity): 設定の拡張と 0600 の保存、呼び手の非同期な境界"
```

### Task 2: AccessIdentity

**Files:**
- Create: `src/identity/access.ts`、`test/helpers/jwt.ts`
- Modify: `src/api/app.ts`（CSRFの検査）
- Test: `test/identity/access.test.ts`、`test/api/app.test.ts`

**Interfaces:**
- Produces:

```ts
// src/identity/access.ts
export type Jwks = { keys: (JsonWebKey & { kid: string })[] };
export type AccessDeps = {
  teamDomain: string; aud: string;
  fetchJwks?: () => Promise<Jwks>;        // 既定は fetch(`https://${teamDomain}/cdn-cgi/access/certs`)。1時間メモリに持ち、未知の kid で1回だけ取り直す
  now?: () => number; local?: Identity;   // local の既定は HeaderIdentity
};
export class AccessIdentity implements Identity { constructor(deps: AccessDeps); callerOf(req: Request): Promise<Caller> }
// test/helpers/jwt.ts
export async function makeKeys(kid?: string): Promise<{ jwks: Jwks; sign: (payload: Record<string, unknown>) => Promise<string> }>; // RSASSA-PKCS1-v1_5 2048、RS256
```

規則（仕様2.1）。
1. トークンは`cf-access-jwt-assertion`ヘッダ、無ければcookie`CF_Authorization`。
2. トークンがあれば署名（RS256、kid）、`aud`に設定のaudを含む、`iss === https://<teamDomain>`、`exp > now`を確かめる。失敗は`AccessDenied(403, "access: <理由>")`。
   - `email`があれば`{ id: email, kind: "user" }`。`x-cc-from`と`x-cc-via`は捨てる。
   - `common_name`があれば`{ id: x-cc-from ?? "agent:" + common_name, via: x-cc-via ?? undefined, kind: "node" }`。
   - どちらも無ければ403。
3. トークンが無く`cf-connecting-ip`ヘッダがあれば`AccessDenied(401, "access token required")`。
4. それ以外は`local.callerOf(req)`。

CSRF（app.ts）。`caller.kind === "user"`でmethodがGET以外のとき、`origin`ヘッダがあって`new URL(req.url).origin`と違えば403、`sec-fetch-site`があって`same-origin`でも`none`でもなければ403。

- [ ] **Step 1: 失敗する試験を書く**

```ts
test("email jwt yields the email and drops x-cc-from", ...);                   // 期待 { id: "ceo@fybe.jp", kind: "user" }
test("service token jwt accepts x-cc-from and x-cc-via", ...);                 // common_name "cc-node" + ヘッダ → { id: "agent:lead", via: "vm", kind: "node" }
test("service token jwt without headers names the token", ...);                // { id: "agent:cc-node", kind: "node" }
test("wrong aud, expired and foreign signature are 403", ...);                 // 3 件とも AccessDenied.status === 403
test("through cloudflare without a token is 401", ...);                        // cf-connecting-ip だけ
test("plain local request falls back to headers", ...);                        // x-cc-from → { id, kind: "local" }
test("unknown kid refetches the jwks once", ...);                              // fetchJwks の呼び出し 2 回
test("cross-site POST with a user jwt is 403", ...);                           // app.test: origin が違う
```

- [ ] **Step 2: 失敗を確かめる**

Run: `bun test test/identity/access.test.ts`
Expected: FAIL（モジュールが無い）

- [ ] **Step 3: 書く**

JWTの検証は旧`online-claudecode/hub/lib/access.ts`（本番で動いていた）を参考にWebCryptoで書く。ライブラリは入れない。

- [ ] **Step 4: 通ることを確かめる**

Run: `bun test`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src test && git commit -m "feat(identity): Access の JWT を呼び手に変える AccessIdentity と CSRF の検査"
```

### Task 3: 登録簿と GET /api/peers

**Files:**
- Create: `src/registry/registry.ts`、`src/registry/cloudflare.ts`
- Modify: `src/api/app.ts`、`src/api/sessions.ts`（Depsにregistry）、`src/api/errors.ts`、`src/main.ts`
- Test: `test/registry/cloudflare.test.ts`、`test/api/app.test.ts`

**Interfaces:**
- Produces:

```ts
// src/registry/registry.ts
export type PeerStatus = "healthy" | "degraded" | "down" | "inactive";
export type Peer = { name: string; url: string; status: PeerStatus; self: boolean };
export interface Registry { peers(): Promise<Peer[]> }
export class StaticRegistry implements Registry { constructor(peers: Peer[]) }
export class RegistryError extends Error { constructor(public status: number, msg: string) }   // API では 502
// src/registry/cloudflare.ts
export type CloudflareDeps = { accountId: string; apiToken: string; domain: string; selfName: string; prefix?: string; fetchFn?: typeof fetch; cacheMs?: number; now?: () => number };
export class CloudflareRegistry implements Registry {}
// GET https://api.cloudflare.com/client/v4/accounts/<accountId>/cfd_tunnel?is_deleted=false&per_page=100、authorization: Bearer <apiToken>
// result[] のうち name が prefix（既定 "cc-"）で始まるものを { name: 残り, url: https://<残り>.<domain>, status, self: 残り === selfName } にし、名前順。cacheMs（既定 10000）はメモリ
```

`GET /api/peers`は`Peer[]`。設定にcfApiTokenとaccountIdが無いノードは`StaticRegistry([{ name: cfg.name, url: entryOf(cfg) ?? "http://127.0.0.1:<port>", status: "healthy", self: true }])`。

- [ ] **Step 1: 失敗する試験を書く**

```ts
test("maps cc- tunnels to peers with urls and marks self", ...);   // fetchFn が {result:[{name:"cc-vm",status:"healthy"},{name:"air",status:"down"},{name:"cc-pro",status:"down"}]} → 2 件、vm.url === "https://vm.cc.fybe.jp"、pro.self === true（selfName "pro"）
test("sends the bearer token and the is_deleted filter", ...);
test("caches within cacheMs", ...);                                 // 2 回呼んで fetchFn 1 回
test("non-2xx becomes RegistryError 502", ...);
test("GET /api/peers returns the registry", ...);                   // app.test、StaticRegistry
```

- [ ] **Step 2: 失敗を確かめる**

Run: `bun test test/registry`
Expected: FAIL

- [ ] **Step 3: 書く**

- [ ] **Step 4: 通ることを確かめる**

Run: `bun test`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src test && git commit -m "feat(registry): Cloudflare のトンネル一覧を登録簿にし、GET /api/peers を足す"
```

### Task 4: 中継 /n/:peer

**Files:**
- Create: `src/relay/relay.ts`
- Modify: `src/api/app.ts`、`src/api/errors.ts`、`src/main.ts`
- Test: `test/relay/relay.test.ts`、`test/api/app.test.ts`

**Interfaces:**
- Produces:

```ts
// src/relay/relay.ts
export type RelayDeps = { registry: Registry; nodeName: string; serviceToken?: { clientId: string; clientSecret: string }; fetchFn?: typeof fetch; timeoutMs?: number };
export class UnknownPeerError extends Error { constructor(public peer: string) }   // 404
export class PeerUnreachableError extends Error { constructor(public peer: string, cause: unknown) }   // 502
export class Relay {
  constructor(deps: RelayDeps);
  async forward(peer: string, rest: string, req: Request, caller: Caller): Promise<Response>;
}
```

- 送り先は`<peer.url>/<rest><search>`。methodとbody（GET以外）をそのまま。写すヘッダは`content-type`、`accept`、`last-event-id`。足すヘッダは`CF-Access-Client-Id`、`CF-Access-Client-Secret`、`x-cc-from: caller.id`、`x-cc-via: caller.via ?? nodeName`。`redirect: "manual"`。
- 返すのは相手のstatusとbody（ストリームのまま）と`content-type`、`cache-control`。
- serviceTokenが無ければ503 `{ error: "relay needs a service token" }`。fetchが失敗（reject、またはtimeoutMsで最初の応答が無い。既定15秒。SSEは応答ヘッダが返れば以後は待たない）したら`PeerUnreachableError`。
- `app.ts`。`/n/<peer>/api/...`は、`peer === cfg.name`なら`/api/...`として手元で処理し、違えば`relay.forward`。`/n/<peer>/`以外の形は404。

- [ ] **Step 1: 失敗する試験を書く**

```ts
test("forwards method, path, query and body with the service token and caller headers", ...);  // fetchFn が受けた Request を検査
test("streams the upstream body and content-type back", ...);         // text/event-stream をそのまま
test("unknown peer is 404", ...);
test("unreachable peer is 502 with the peer name", ...);               // fetchFn が reject
test("self peer is handled locally", ...);                             // app.test: /n/vm/api/host が /api/host と同じ
test("relay without service token is 503", ...);
```

- [ ] **Step 2: 失敗を確かめる**

Run: `bun test test/relay`
Expected: FAIL

- [ ] **Step 3: 書く**

- [ ] **Step 4: 通ることを確かめる**

Run: `bun test`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src test && git commit -m "feat(relay): /n/:peer を相手ノードにサービストークンで中継し、呼び手を運ぶ"
```

### Task 5: /install と参加トークン

**Files:**
- Create: `src/join/token.ts`、`src/join/installer.ts`、`src/join/bundle.ts`、`src/cli/name.ts`
- Modify: `src/api/app.ts`、`src/main.ts`
- Test: `test/join/token.test.ts`、`test/join/installer.test.ts`、`test/api/app.test.ts`

**Interfaces:**
- Produces:

```ts
// src/cli/name.ts
export const CLI_NAME = "cc";
// src/join/token.ts
export type JoinToken = { v: 1; name: string; port: number; domain: string; zone: string; teamDomain: string; aud: string; accountId: string; entry: string; tunnelToken: string; serviceToken: { clientId: string; clientSecret: string }; cfApiToken: string };
export function encodeJoinToken(t: JoinToken): string;                 // base64url(JSON)
export function decodeJoinToken(s: string): JoinToken;                 // 前後の空白と改行を除く。壊れていれば JoinTokenError("<欠けた項目か理由>")
export class JoinTokenError extends Error {}
export function configFromToken(t: JoinToken): Config;                 // roots は [$HOME]
// src/join/installer.ts
export function installerScript(o: { entry: string; cliName: string }): string;   // POSIX sh
// src/join/bundle.ts
export function bundle(appRoot: string): ReadableStream<Uint8Array>;   // tar czf - -C appRoot src skills bin package.json bun.lock tsconfig.json README.md
export const BUNDLE_PATHS: string[];
```

インストーラの中身（sh、`set -eu`）。
1. 参加トークンを`/dev/tty`から1行読む。`/dev/tty`が開けなければ標準入力から読む。引数と環境変数は使わない。
2. `bun`が無ければ`curl -fsSL https://bun.sh/install | bash`（`~/.bun/bin`）。`cloudflared`が無ければ、macOSはbrewがあれば`brew install cloudflared`、無ければ`https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-darwin-<arm64|amd64>.tgz`を`~/.local/bin`へ、Linuxは`.../cloudflared-linux-<amd64|arm64>`を`~/.local/bin/cloudflared`へ。
3. `${entry}/install/cc.tar.gz`を`~/.local/share/cc/app.new`に展開し、`bun install --frozen-lockfile --production`、`app`と入れ替える。
4. `printf '%s' "$TOKEN" | bun run src/cli/cc.ts install`。

経路。`GET /install`は`text/plain`でスクリプト（entryは`x-forwarded-host`か`host`から。`127.0.0.1`ならhttp）。`GET /install/cc.tar.gz`は`application/gzip`で`bundle(appRoot)`。どちらも呼び手の解決をしない。

- [ ] **Step 1: 失敗する試験を書く**

```ts
test("join token round-trips", ...);
test("decode strips whitespace and rejects missing fields by name", ...);   // "abc\n" が通る。serviceToken 無しは JoinTokenError に "serviceToken"
test("installer reads the token from /dev/tty or stdin and never from argv", ...);   // 文字列に "/dev/tty" と "read -r" があり "$1" が無い
test("GET /install is public and names the entry from the host header", ...);     // identity が拒否しても 200。本文に https://vm.cc.fybe.jp
test("GET /install/cc.tar.gz is gzip", ...);                                        // 先頭2バイト 1f 8b
```

- [ ] **Step 2: 失敗を確かめる**

Run: `bun test test/join`
Expected: FAIL

- [ ] **Step 3: 書く**

- [ ] **Step 4: 通ることを確かめる**

Run: `bun test`、そのあと`bun run src/main.ts`を別ポートで立てて`curl -s http://127.0.0.1:<port>/install | sh -n`
Expected: PASS。`sh -n`が何も言わない

- [ ] **Step 5: Commit**

```bash
git add src test && git commit -m "feat(join): 参加トークン、/install のスクリプトと実行物の配布"
```

### Task 6: 常駐（launchd と systemd --user）

**Files:**
- Create: `src/join/services.ts`
- Test: `test/join/services.test.ts`

**Interfaces:**
- Produces:

```ts
export type Paths = { home: string; appDir: string; configDir: string; logDir: string; bun: string; cloudflared: string; uid: number };
export type ServiceKind = "node" | "tunnel";
export function launchdPlist(kind: ServiceKind, p: Paths): string;   // Label jp.fybe.cc.<kind>、ProgramArguments、KeepAlive true、RunAtLoad true、EnvironmentVariables.PATH に ~/.bun/bin と /opt/homebrew/bin、StandardOutPath/ErrorPath は logDir
export function systemdUnit(kind: ServiceKind, p: Paths): string;    // [Service] ExecStart、Restart=always、RestartSec=3、Environment=PATH=...、[Install] WantedBy=default.target
export interface ServiceManager { install(): Promise<void>; uninstall(): Promise<void>; restart(kind: ServiceKind): Promise<void>; status(): Promise<Record<ServiceKind, "running" | "stopped" | "unknown">> }
export function serviceManager(platform: "darwin" | "linux", p: Paths, run: Runner, write: (path: string, text: string) => void): ServiceManager;
```

- nodeの命令は`<bun> run <appDir>/src/cli/cc.ts serve`。tunnelは`<cloudflared> tunnel run --token-file <configDir>/tunnel.token`。
- darwinのinstallは、plistを`~/Library/LaunchAgents/jp.fybe.cc.<kind>.plist`に書き、`launchctl bootout gui/<uid>/<label>`（失敗は無視）→`launchctl bootstrap gui/<uid> <plist>`。uninstallはbootoutとplistの削除。
- linuxのinstallは、unitを`~/.config/systemd/user/cc-<kind>.service`に書き、`systemctl --user daemon-reload`→`systemctl --user enable --now cc-<kind>`。uninstallは`disable --now`とunitの削除。

- [ ] **Step 1: 失敗する試験を書く**

```ts
test("launchd plist runs bun serve and cloudflared with the token file", ...);   // 文字列検査。<string>tunnel</string> と --token-file と KeepAlive
test("systemd unit restarts always and installs to default.target", ...);
test("darwin install writes two plists and bootstraps both", ...);               // run の呼び出し列
test("linux install reloads then enables both", ...);
```

- [ ] **Step 2: 失敗を確かめる**

Run: `bun test test/join/services.test.ts`
Expected: FAIL

- [ ] **Step 3: 書く**

- [ ] **Step 4: 通ることを確かめる**

Run: `bun test`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src test && git commit -m "feat(join): launchd と systemd --user の常駐"
```

### Task 7: cf の包み（setup、node add、node remove、entry）

**Files:**
- Create: `src/join/cf.ts`
- Test: `test/join/cf.test.ts`

**Interfaces:**
- Produces:

```ts
export type CfRunner = (args: string[]) => Promise<{ stdout: string; code: number }>;   // 本物は Bun.spawn(["cf", ...args, "-q"])。秘密は argv に出さない（cf は OAuth で、トークンを渡す引数は無い）
export async function ensureAccessApp(cf: CfRunner, o: { name: string; hosts: string[]; sessionDuration: string; email: string; serviceTokenId: string }): Promise<{ id: string; aud: string }>;
export async function ensureBypassApp(cf: CfRunner, o: { name: string; hosts: string[] }): Promise<{ id: string }>;     // hosts は "<host>/install" にして入れる。policy は decision "bypass"、include [{ everyone: {} }]
export async function ensureServiceToken(cf: CfRunner, o: { name: string; duration: string }): Promise<{ id: string; clientId: string; clientSecret?: string }>;   // 既存なら secret 無し
export async function createNodeTunnel(cf: CfRunner, o: { name: string; hostname: string; port: number; zone: string }): Promise<{ tunnelId: string; token: string }>;
export async function removeNodeTunnel(cf: CfRunner, o: { name: string; hostname: string; zone: string }): Promise<void>;
export async function setEntry(cf: CfRunner, o: { name: string; entryHost: string; port: number; zone: string }): Promise<void>;   // ingress に entryHost を足し、entryHost の CNAME をそのトンネルへ
```

- `ensure*`は`list`で名前を探し、無ければ`create --body <json>`、あれば`update <id> --body <json>`（PUTなので全文）。アプリの本文は`{ name, type: "self_hosted", domain: hosts[0], self_hosted_domains: hosts, session_duration, app_launcher_visible: false, policies: [{ name: "owner", decision: "allow", include: [{ email: { email } }] }, { name: "nodes", decision: "non_identity", include: [{ service_token: { token_id } }] }] }`。
- `createNodeTunnel`は`tunnels create --name cc-<name> --config-src cloudflare`→`tunnels config update <id> --body {"config":{"ingress":[{"hostname":"<hostname>","service":"http://127.0.0.1:<port>"},{"service":"http_status:404"}]}}`→`dns records create -z <zone> --body {"type":"CNAME","name":"<hostname>","content":"<id>.cfargotunnel.com","proxied":true}`→`tunnels token get <id>`。フラグ名は実行時に`--help`で確かめ、違えば`--body`に寄せる。
- `removeNodeTunnel`はDNSを消してからトンネルを消す。既に無いものは無視する。

- [ ] **Step 1: 失敗する試験を書く**

偽の`CfRunner`は`args`を記録し、`list`には固定の配列、`create`には`{ result: { id, aud, client_id, client_secret } }`を返す。

```ts
test("ensureAccessApp creates with both policies when missing", ...);     // --body の JSON に self_hosted_domains、session_duration "720h"、email、service_token
test("ensureAccessApp updates by id when the name exists", ...);
test("ensureServiceToken returns the secret only on create", ...);
test("createNodeTunnel runs create, config, dns, token in order and never prints the token", ...);
test("removeNodeTunnel deletes dns before tunnel and ignores missing", ...);
test("setEntry appends the entry hostname to the ingress and points the cname", ...);
```

- [ ] **Step 2: 失敗を確かめる**

Run: `bun test test/join/cf.test.ts`
Expected: FAIL

- [ ] **Step 3: 書く**

- [ ] **Step 4: 通ることを確かめる**

Run: `bun test`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src test && git commit -m "feat(join): cf で Access アプリ、サービストークン、トンネル、DNS を揃える"
```

### Task 8: cc CLI（親向けの命令）

**Files:**
- Create: `src/cli/cc.ts`、`src/cli/args.ts`、`src/cli/client.ts`、`src/cli/resolve.ts`、`src/cli/read.ts`、`src/cli/commands.ts`、`src/cli/sends.ts`、`bin/cc`
- Test: `test/cli/args.test.ts`、`test/cli/client.test.ts`、`test/cli/resolve.test.ts`、`test/cli/commands.test.ts`

**Interfaces:**
- Produces:

```ts
// src/cli/args.ts
export function parseArgs(argv: string[]): { words: string[]; flags: Record<string, string | true> };   // --k v、--k=v、--flag。"-" は words
// src/cli/client.ts
export type Client = { peer: string; base: string; headers: Record<string, string> };
export function agentName(nodeName: string, sessionId: string | undefined, role: string | undefined): string;   // 旧 inbox と同じ。`<nodeName>/<sid8>/<role>`、既定の役割 parent、64 文字まで
export function clientFor(cfg: Config, peer: string | undefined, role: string | undefined, env: NodeJS.ProcessEnv): Client;
//   peer が無いか cfg.name なら base http://127.0.0.1:<port>、ヘッダは x-cc-from: agent:<agentName>、x-cc-via: <cfg.name>
//   違えば base https://<peer>.<cfg.domain>、上に CF-Access-Client-Id/Secret を足す。serviceToken が無ければ CliError
//   sessionId は env.CLAUDE_CODE_SESSION_ID
export async function api<T>(c: Client, method: string, path: string, body?: unknown, fetchFn?: typeof fetch): Promise<T>;   // 非 2xx は CliError(status, body)
export class CliError extends Error { constructor(public code: number, msg: string) }
// src/cli/resolve.ts
export function parseTarget(t: string): { peer?: string; id: string };          // "vm/abcd1234" か "abcd1234…"
export function matchSession(list: SessionSummary[], id: string): SessionSummary;  // 先頭一致。8 文字未満、0 件、複数は CliError
// src/cli/sends.ts（CLI の手元の控え。~/.config/cc/sends.json。ノードではない）
export function rememberSeq(key: string, seq: number): void; export function lastSeq(key: string): number | undefined;
// src/cli/read.ts
export async function readUntilResult(c: Client, s: SessionSummary, after: number, waitSec: number, out: (line: string) => void, fetchFn?: typeof fetch): Promise<{ code: 0 | 2 | 3 | 4; seq: number }>;
//   events 能力があれば SSE を after から読み、result で 0。permission_request で 3（続きは待たない）。exited で 4。waitSec で 2
//   無ければ messages?after= を 3 秒ごとに読み、新しい assistant が来て state が idle になったら 0
//   出すのは assistant の text、tool_use は "[tool] <name> <description か file_path>"、最後に "state=<s> pending=<n> seq=<n>"
// src/cli/commands.ts
export type Ctx = { cfg: Config; env: NodeJS.ProcessEnv; out: (s: string) => void; fetchFn: typeof fetch; stdin: () => Promise<string> };
export async function main(argv: string[], ctx: Ctx): Promise<number>;
```

命令と振る舞い（仕様「第2部で決めたこと」）。

| 命令 | すること |
| --- | --- |
| `peers` | 手元の`GET /api/peers`。`name status url`を1行ずつ |
| `ls [--peer] [--mine]` | 指定のpeer、無ければ全peer（並列、落ちたpeerは1行で理由）。`<peer>/<id8> <kind> <state> <cwd> <parent> <title>`。`--mine`は`parent`が`agent:<nodeName>/<sid8>/`で始まるもの |
| `show <対象>` | `GET /api/sessions/:id`。項目を1行ずつ、pendingは`requestId toolName description` |
| `new <dir> <文> [--peer] [--mode] [--model] [--resume] [--as]` | `POST /api/sessions`。`--mode`の既定は`bypassPermissions`。`<peer>/<id>`を出す |
| `send <対象> <文|-> [--as]` | `POST .../messages`。送る前の`messages?after=0`の`next`を控え、`seq=<n>`を出す |
| `read <対象> [--after] [--wait]` | `--after`の既定は控え、無ければ0。`--wait`の既定120。終了コードは`readUntilResult` |
| `run <対象> <文> [--wait]` | sendのあとread |
| `wait <対象>... [--wait]` | 全部を並列にread。終了コードは最大 |
| `allow <対象> [requestId]`、`deny <対象> [requestId] <理由>` | pendingが1件ならrequestId省略可。0件か複数はCliError |
| `interrupt <対象>`、`stop <対象>` | `POST .../interrupt`、`DELETE` |

`bin/cc`は`#!/bin/sh`で`exec bun run "$(dirname "$0")/../src/cli/cc.ts" "$@"`。

- [ ] **Step 1: 失敗する試験を書く**

```ts
test("parseArgs separates words and flags", ...);
test("clientFor targets localhost without a service token and peers with it", ...);
test("agentName follows <node>/<sid8>/<role>", ...);
test("matchSession rejects short prefixes and ambiguity", ...);
test("new posts cwd, from-line-free prompt and bypass mode by default", ...);   // fetchFn の Request を検査。body.prompt は生の文（from 行はノードが付ける）
test("send remembers the seq and read uses it", ...);
test("read over sse returns 3 on permission_request and 0 on result", ...);       // fetchFn が text/event-stream を返す
test("read polls messages when the session has no events capability", ...);
test("allow picks the single pending request", ...);
```

- [ ] **Step 2: 失敗を確かめる**

Run: `bun test test/cli`
Expected: FAIL

- [ ] **Step 3: 書く**

- [ ] **Step 4: 通ることを確かめる**

Run: `bun test`、`bun run src/cli/cc.ts --help`
Expected: PASS。使い方が出る

- [ ] **Step 5: Commit**

```bash
git add src bin test && git commit -m "feat(cli): cc の親向け命令（peers、ls、show、new、send、read、run、wait、allow、deny、interrupt、stop）"
```

### Task 9: cc CLI（参加側：setup、node add、node remove、entry、install、update、uninstall、doctor、serve）

**Files:**
- Create: `src/cli/join-commands.ts`、`src/join/settings.ts`、`src/join/skill-links.ts`
- Modify: `src/cli/commands.ts`、`src/main.ts`（`serve`から呼べるよう`start(cfg)`を出す）
- Test: `test/cli/join-commands.test.ts`、`test/join/settings.test.ts`

**Interfaces:**
- Produces:

```ts
// src/join/settings.ts
export function withCrossSessionInbound(text: string): string;   // settings.json の文字列を受け、{"crossSessionInbound":"accept"} を併合した文字列を返す。空文字や壊れた JSON は SettingsError（書かない）
// src/join/skill-links.ts
export function linkSkill(o: { home: string; appDir: string; configDir: string; now: Date }, fs: FsOps): void;
//   ~/.agents/skills/session-inbox が appDir への symlink でなければ session-inbox.old-<YYYYMMDD-HHmm> に退避し、symlink を張る
//   ~/.claude/skills/session-inbox が無ければ ../../.agents/skills/session-inbox への相対 symlink
//   ~/.config/session-inbox/child.md は既存を .old-<時刻> に退避して appDir/skills/session-inbox/child.md を複製
// src/cli/join-commands.ts（Ctx に cf: CfRunner、services: (platform, paths) => ServiceManager、fs、platform、tty: () => Promise<string> を足す）
```

| 命令 | すること |
| --- | --- |
| `setup --hosts <a,b> [--name] [--port] [--email ceo@fybe.jp] [--domain] [--zone] [--team-domain] [--account-id]` | cfのMacで1回。domain、zone、teamDomain、accountIdの既定はGlobal Constraintsの公開値。`ensureServiceToken("cc-node","8760h")`→`ensureAccessApp("cc", hosts, "720h", email, tokenId)`→`ensureBypassApp("cc-install", hosts)`。secretが返らず手元のcc.jsonにも無ければ止めて`service-tokens rotate`を案内する。cfApiTokenがcc.jsonに無ければ`tty()`で読む。domain、zone、teamDomain、aud、accountId、serviceToken、cfApiToken、name、portをcc.jsonに保存（0600） |
| `node add <name> [--port 4322]` | cc.jsonを読み、`createNodeTunnel`→`JoinToken`を組み（entryは`entryOf(cfg)`）→`encodeJoinToken`。`pbcopy`があればそこへ入れ「クリップボードに入れた」とだけ出す。無ければttyに1回出す。標準出力には出さない。インストール命令`curl -fsSL <entry>/install \| sh`を出す |
| `node remove <name>` | `removeNodeTunnel` |
| `entry <name>` | `setEntry`（移行日用） |
| `install [--from <dir>]` | 標準入力の参加トークン→`configFromToken`→cc.jsonとtunnel.tokenを0600で書く→`--from`があればそのdirをappDirに複製（ブートストラップ用。無ければ既にインストーラが置いている）→`withCrossSessionInbound`で`~/.claude/settings.json`を直す（無ければ作る）→`linkSkill`→`~/.local/bin/<CLI_NAME>`を`<appDir>/bin/cc`へのsymlinkにする→`services.install()`→`doctor` |
| `update` | `${entryOf(cfg)}/install/cc.tar.gz`を`app.new`に展開→`bun install --frozen-lockfile --production`→入れ替え→`services.restart("node")` |
| `uninstall` | `services.uninstall()`→`~/.local/share/cc`と`~/.config/cc`を消す。`~/.claude/settings.json`とスキルのリンクは残す（案内だけ出す） |
| `doctor` | 1行ずつ ok/ng。claudeの版（試験済みの2.1.318と違えば警告）、`claude agents --json`、常駐2つの状態、`GET http://127.0.0.1:<port>/api/host`、サービストークンで`GET https://<name>.<domain>/api/host`（Access→トンネル→ノード）、短いnodeセッション（prompt "reply with ok"、cwdは$HOME）がresultまで通る。仕様の「起動時に自分宛てのソケット疎通確認」は、対話セッションが無いと確かめられないので入れない。代わりに版の警告で代える（こちらの判断） |
| `serve` | `start(loadConfig())` |

- [ ] **Step 1: 失敗する試験を書く**

```ts
test("withCrossSessionInbound merges and keeps other keys", ...);     // {"a":1} → a と crossSessionInbound
test("withCrossSessionInbound refuses empty text", ...);               // 読み出しが空なら書かない
test("install writes cc.json and tunnel.token with 0600 and refuses a broken token before writing", ...);   // 偽 fs。壊れたトークンでは write が 0 回
test("setup calls service token, access app, bypass app in order and saves aud", ...);
test("node add never writes the token to stdout", ...);                // out に base64 が無い。pbcopy 偽物が受ける
test("update swaps app.new into app and restarts node", ...);
```

- [ ] **Step 2: 失敗を確かめる**

Run: `bun test test/cli test/join`
Expected: FAIL

- [ ] **Step 3: 書く**

- [ ] **Step 4: 通ることを確かめる**

Run: `bun test`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src test && git commit -m "feat(cli): 参加側の命令（setup、node add/remove、entry、install、update、uninstall、doctor、serve）"
```

### Task 10: 画面

**Files:**
- Create: `src/web/index.html`、`src/web/page.ts`
- Modify: `src/api/app.ts`、`src/main.ts`
- Test: `test/api/app.test.ts`

**Interfaces:**
- Produces: `GET /`と`GET /index.html`が`text/html`で1枚を返す（呼び手の解決あり）。`page.ts`は`export const pageHtml: () => Promise<string>`（`Bun.file(import.meta.dir + "/index.html")`）。

画面（ビルド無し、外部ライブラリ無し、白ベース）。
- 3段。左「パソコン」（`/api/peers`。各peerに`/n/<peer>/api/host`を並列で取り、claudeの版、アカウント、負荷、動いているセッション数。downは名前とdownだけ）。中「セッション」（`/n/<peer>/api/sessions`。kind、state、cwdの末尾、title、parent。10秒ごとと`/n/<peer>/api/events`で更新）。右「会話」。
- 会話は`messages?after=0`を読んでから`events?after=<最後のseq>`をEventSourceで続ける。`events`能力が無いか過去のものは`messages`だけ。表示は、userの文、assistantのtext（Markdownは旧index.htmlの`md()`を移す。先に全部エスケープ）、tool_useは折りたたみ（名前と入力の要約）、tool_resultは折りたたみ、permission_requestは許可と拒否のボタンの札、resultは費用の1行。
- 操作は、送信、許可と拒否、中断、停止、作成（peer、cwd、文、mode）、再開（exitedの会話に「続きから」）。
- スマホ（768px未満）は1画面で段を切り替え、戻るボタン。PCは3列。
- localStorageは`cc.peer`、`cc.session`、`cc.draft.<session>`。

- [ ] **Step 1: 失敗する試験を書く**

```ts
test("GET / serves the page to an authenticated caller", ...);   // 200、text/html、"<title>cc</title>"
```

- [ ] **Step 2: 失敗を確かめる**

Run: `bun test test/api`
Expected: FAIL

- [ ] **Step 3: 書く**

- [ ] **Step 4: 通ることを確かめる**

Run: `bun test`。手元で`bun run src/main.ts`（別ポート）を立て、Claude in Chromeで`http://127.0.0.1:<port>/`を開き、自分のパソコンと端末セッションが出て、会話が読めることを目で見る
Expected: PASS。画面が出る

- [ ] **Step 5: Commit**

```bash
git add src test && git commit -m "feat(web): パソコン、セッション、会話の3段の1枚の画面"
```

### Task 11: スキル session-inbox と child.md

**Files:**
- Create: `skills/session-inbox/SKILL.md`、`skills/session-inbox/child.md`

旧`~/.agents/skills/session-inbox/SKILL.md`の構成（既定の使い方、仕組み、流れ、命令、命令の書き方、触らないもの、報告、状況の読み方、設定）を保ち、中身を新APIに合わせる。変える点。
- `inbox`を`cc`に。命令表はTask 8のもの。`spawn`は`cc new <dir> <文> --peer <名>`。対象は`<peer>/<id8>`。
- 親の文は子に「from agent:<ノード>/<sid8>/<役割> via <ノード>」で届く。権限プロンプトは`cc show`のpendingで見て`cc allow`と`cc deny`で答える（子を`--mode default`で立てたとき）。既定はbypass。
- 子の返事は`cc read`（SSEでresultまで）。終了コードは0、2、3（権限待ち）、4（exited）。
- 設定は`~/.config/cc/cc.json`だけ。`--hub`は無い。
- child.mdは、from行の形（`via <ノード名>`）、`[session-inbox] 定義`の扱い、`agent:`からの依頼の扱い（旧文のまま）を書き、「中身は ~/Documents/cc-web にある」に直す。

- [ ] **Step 1: 書く**

- [ ] **Step 2: 確かめる**

Run: `grep -n "inbox " skills/session-inbox/SKILL.md | grep -v "session-inbox"`
Expected: 何も出ない（旧命令が残っていない）

- [ ] **Step 3: Commit**

```bash
git add skills && git commit -m "docs(skill): session-inbox と child.md を cc に合わせて書き直す"
```

### Task 12: 試作3（VMをトンネルとAccessで外に出す）

**Files:**
- Create: `scripts/smoke-remote.sh`（`<host>`を受け、cc.jsonのサービストークンで`/api/host`、作成、SSE、送信、承認、中断、DELETEをcurlで通す）、`docs/results/2026-11-06-application-vm.md`

前提。本人がダッシュボードでCF APIトークン（Account / Cloudflare Tunnel / Read、fybe.jp）を作ってある。

- [ ] **Step 1: Macで1回だけの準備**

Run: `bun run src/cli/cc.ts setup --hosts '*.cc.fybe.jp' --name konaito-pro --port 4323`（CF APIトークンを/dev/ttyで聞くので本人が貼る）
Expected: `cf zero-trust access applications list`に`cc`（`*.cc.fybe.jp`、720h、方針2つ）と`cc-install`（`*.cc.fybe.jp/install`、bypass）、`service-tokens list`に`cc-node`。`~/.config/cc/cc.json`が0600。既存のアプリとトークンは変わっていない（listで前後を比べる）

- [ ] **Step 2: VMのノードを作る**

Run: `bun run src/cli/cc.ts node add vm`
Expected: `cf tunnels list`に`cc-vm`（remote、inactive）、DNSに`vm.cc.fybe.jp`のCNAME。参加トークンはクリップボード

- [ ] **Step 3: VMで参加（ブートストラップ。入口がまだ無いので`--from`）**

Run: `pbpaste | orb run -m ubuntu bash -lc 'export PATH=$HOME/.bun/bin:$HOME/.local/bin:$PATH && cd /Users/konaito/Documents/cc-web && bun run src/cli/cc.ts install --from /Users/konaito/Documents/cc-web'`
Expected: `systemctl --user status cc-node cc-tunnel`がactive。`cf tunnels list`で`cc-vm`がhealthy。doctorが全部ok

- [ ] **Step 4: 外から通す**

Run: `scripts/smoke-remote.sh vm.cc.fybe.jp`
Expected: 認証無しの`GET /api/host`は302（Accessのログイン画面）。サービストークン付きは200でname vm。作成201、SSEにresult、送信200、permission_requestにallowでファイルができる、中断、DELETE 204

- [ ] **Step 5: ブラウザ**

Claude in Chromeで`https://vm.cc.fybe.jp/`を開く。ログイン（ワンタイムコード）は本人。画面にvmと、そのセッションが出て、送信した文がnodeセッションに届く
Expected: 画面が出る。送った文の返事が会話に出る

- [ ] **Step 6: 結果を残して Commit**

`docs/results/2026-11-06-application-vm.md`に、実行した命令、応答、かかった時間、cfで見えたもの（名前とid。秘密は無し）、ブラウザで見たものを書く。

```bash
git add scripts docs && git commit -m "docs: VM をトンネルと Access で出した結果"
```

### Task 13: 試作4（Macを公開インストーラで足し、中継と親子を通す）

**Files:**
- Create: `docs/results/2026-11-06-application-two-nodes.md`

- [ ] **Step 1: Macのノードを作る**

Run: `bun run src/cli/cc.ts node add konaito-pro --port 4323`
Expected: `cc-konaito-pro`とCNAME。トークンはクリップボード

- [ ] **Step 2: 公開インストーラで参加（入口はVM）**

Run: `pbpaste | sh -c "$(curl -fsSL https://vm.cc.fybe.jp/install)"`
Expected: `/install`がAccess無しで200（Bypassがパス付きアプリで効いた。仕様の確認事項9の答え）。`~/.local/share/cc/app`、LaunchAgent 2つ、`~/.config/cc/cc.json`。`cf tunnels list`で`cc-konaito-pro`がhealthy。旧ノード（4322、com.konaito.session-inbox）は動いたまま

- [ ] **Step 3: 登録簿と中継**

Run: `curl`（サービストークン）で`https://vm.cc.fybe.jp/api/peers`、`https://vm.cc.fybe.jp/n/konaito-pro/api/sessions`
Expected: peersにvmとkonaito-proがhealthy。中継でMacの端末セッションが見える

- [ ] **Step 4: 親子**

Macの端末（この作業のClaude Code）から`cc new ~/work "..." --peer vm --as lead --mode default`、`cc read`、`cc show`でpending、`cc allow`、`cc read`、`cc stop`。VMから`cc ls --peer konaito-pro`
Expected: 子のfrom行が`from agent:konaito-pro/<sid8>/lead via konaito-pro`。allowでファイルができる

- [ ] **Step 5: 結果を残して Commit**

```bash
git add docs && git commit -m "docs: 2 台目の参加、中継、親子の結果"
```

### Task 14: 画面の目視と直し

- [ ] **Step 1: Claude in Chromeで`https://vm.cc.fybe.jp/`を開き、PC幅と375px幅で、3段、セッションの切り替え、会話のSSE、送信、許可と拒否、中断、作成、停止、再開を順に使う**
- [ ] **Step 2: 崩れと不具合を直し、Task 10の試験を保ったまま`bun test`**
- [ ] **Step 3: Commit** `git commit -m "fix(web): 目視で見つけた崩れの修正"`

### Task 15: 移行（本人の承認が要る。試作が通ってから）

本番の公開操作。各ステップの前に本人の「やって」を取る。

- [ ] **Step 1: incertotechを足す**。`cc node add incertotech`→`pbpaste | ssh incertotech 'sh -c "$(curl -fsSL https://vm.cc.fybe.jp/install)"'`。healthyを確かめる
- [ ] **Step 2: 旧を止める**。Macの`com.konaito.session-inbox`と`com.konaito.session-inbox-tunnel`をbootout、incertotechも同様。Worker `session-inbox-hub`を消す。
- [ ] **Step 3: 旧のCloudflareを消す**。Accessアプリ`session-inbox`と`session-inbox-nodes`、サービストークン`session-inbox-hub`、`-deploy`、`-parent`、トンネル`session-inbox`と`session-inbox-incerto`、DNS`cc-node-pro`と`cc-node-incerto`と`cc.fybe.jp`のAAAA
- [ ] **Step 4: 入口を切り替える**。`cc setup --hosts '*.cc.fybe.jp,cc.fybe.jp'`（appとbypassに`cc.fybe.jp`を足す）→`cc entry incertotech`（ingressとCNAME）→全ノードの`cc.json`から`entry`を消す（既定の`https://cc.fybe.jp`になる）
- [ ] **Step 5: 確かめる**。ブラウザで`https://cc.fybe.jp/`。3台が出る。この端末に`cc send`で文が届く
- [ ] **Step 6: `docs/results/2026-11-06-application-migration.md`に残し、PRをreadyにする**
