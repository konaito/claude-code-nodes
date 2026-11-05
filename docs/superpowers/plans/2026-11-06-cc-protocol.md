# ccプロトコル（第1部）実装計画

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 1台の機械のClaude Codeを、127.0.0.1のHTTPとSSEで開放するノード（第1部プロトコル）を作り、VMでcurlだけで一通り動かす。

**Architecture:**状態を持たない1つのBunプロセス。engine（Driverの2実装。SDKを包むNodeDriverと受信ソケットに書くTerminalDriver）、sessions（メモリの台帳と過去の合成）、identity（呼び手のヘッダ）、api（HTTPとSSE）をinterfaceでつなぎ、組み立てはmain.tsの1か所だけ。SDKと`claude agents --json`とソケットは、注入した関数の裏に置き、試験は偽物で通す。

**Tech Stack:** Bun 1.3系、TypeScript、`@anthropic-ai/claude-agent-sdk@0.3.318`（Claude Code 2.1.318と同じ版に固定）、`bun test`。

**Spec:** `docs/superpowers/specs/2026-11-06-cc-protocol-design.md`（第1部と「ノードの設計思想」「コードの形」）。第2部アプリケーション（Access、登録簿、中継、参加、画面）は別の計画にする。

## Global Constraints

- コードは`~/Documents/cc-web`（`/private/tmp/cc-web`で始め、2026-11-06にdocumentsスキルで移した。git、mainブランチ）。仕様書と本計画はTask 0で`docs/superpowers/`に写す。
- 待ち受けは`127.0.0.1`だけ。既定のポートは`4322`。
- ノードはファイルを書かない。持つのはプロセスのメモリだけ。設定は`~/.config/cc/cc.json`（無ければ既定値。nameはホスト名、rootsは`[$HOME]`、portは4322）。
- SDKの`query()`には`settingSources: ['user', 'project', 'local']`を必ず渡す。`--bare`に当たるものは使わない。
- APIは種類（node、terminal）ではなく能力（`send`、`permissions`、`interrupt`）で振る舞う。能力に無い操作は409。
- jsonlはSDKの`listSessions`と`getSessionMessages`からだけ読む。受信ソケットには`{"type":"user","message":{"role":"user","content":"..."}}`を1行書く。
- 子のClaudeに届く文は、本文の前に`from <呼び手> via <ノード名>`の1行と空行を付ける。呼び手が無ければ`local`。
- 日本語のコメントで、各ファイルの先頭に1行で責務を書く。既存リポジトリ（online-claudecode）と同じ流儀。
- 実際の`claude`を起動する試験は`CC_LIVE=1`のときだけ動かす。既定の`bun test`はClaude CodeもCloudflareも無しに通る。

## Review Focus

- クライアントが1つも繋がっていない間に権限要求が来る。要求は台帳に残り、`GET /api/sessions/:id`のpendingに出て、後から答えられる（Task 3、Task 8の試験）。
- SSEに途中から繋ぐ。`after`より後のイベントだけを順に受け取り、重複も欠落も無い（Task 2、Task 8の試験）。
- `claude`プロセスが途中で落ちる（認証切れ、強制終了）。状態は`exited`と理由になり、以後の送信は409で`resume`を促す（Task 3、Task 8の試験）。
- `cwd`がrootsの外、または存在しない。`POST /api/sessions`は400で理由を返す（Task 8の試験）。
- 端末セッションのpidが消えていてソケットが無い。送信は410を返し、ノードは落ちない（Task 5の試験）。bypassの受信側で`crossSessionInbound: accept`が無いと保留されるが、ソケットは成功を返すので、APIの応答は「ソケットに書いた」であって「読まれた」ではない。応答の`delivered: "socket"`で表す。

---

### Task 0: 土台

**Files:**
- Create: `/private/tmp/cc-web/package.json`、`tsconfig.json`、`.gitignore`、`README.md`（3行）、`docs/superpowers/specs/2026-11-06-cc-protocol-design.md`（写し）、`docs/superpowers/plans/2026-11-06-cc-protocol.md`（写し）
- Test: `test/smoke.test.ts`

**Interfaces:**
- Produces: `bun test`が通る土台。依存は`@anthropic-ai/claude-agent-sdk@0.3.318`だけ。`bun run src/main.ts`が後で入口になる。

- [ ] **Step 1: 失敗する試験を書く**

```ts
// test/smoke.test.ts
import { test, expect } from "bun:test";
test("sdk is pinned to the cli version", async () => {
  const pkg = await Bun.file("node_modules/@anthropic-ai/claude-agent-sdk/package.json").json();
  expect(pkg.version).toBe("0.3.318");
});
```

- [ ] **Step 2: 失敗を確かめる**

Run: `cd /private/tmp/cc-web && bun test`
Expected: FAIL（node_modulesが無い）

- [ ] **Step 3: 土台を作る**

`git init -b main`。`bun init -y`の後、`bun add @anthropic-ai/claude-agent-sdk@0.3.318`（`^`を外して固定）。`tsconfig.json`は`strict: true`、`moduleResolution: "bundler"`、`types: ["bun-types"]`。`.gitignore`に`node_modules`。仕様書と本計画を`docs/superpowers/`に`cp`する。

- [ ] **Step 4: 通ることを確かめる**

Run: `bun test`
Expected: PASS 1

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "chore: bun と SDK 0.3.318 の土台、仕様書と計画の写し"
```

### Task 1: 境界の型（engine/driver.tsとsessions/types.ts）

**Files:**
- Create: `src/engine/driver.ts`、`src/sessions/types.ts`
- Test: `test/engine/driver.test.ts`

**Interfaces:**
- Produces（以後の全タスクが使う）:

```ts
// src/sessions/types.ts
export type Kind = "node" | "terminal";
export type Capabilities = { send: boolean; permissions: boolean; interrupt: boolean };
export type State = "running" | "waiting_permission" | "idle" | "exited";
export type SessionSummary = {
  id: string; kind: Kind; capabilities: Capabilities; cwd: string; state: State;
  startedAt: number; lastActivityAt: number; model?: string; permissionMode?: string;
  usage?: { inputTokens: number; outputTokens: number; costUsd: number };
  exitReason?: string; pid?: number; title?: string;
  parent?: string;   // 最初の文の from 行の呼び手（"agent:<名前>" か email）。子認識。親側には何も持たない
};
export type PendingPermission = {
  requestId: string; toolName: string; input: Record<string, unknown>;
  description?: string; suggestions?: unknown[]; createdAt: number;
};
export type PermissionAnswer =
  | { behavior: "allow"; updatedInput?: Record<string, unknown>; updatedPermissions?: unknown[] }
  | { behavior: "deny"; message: string };

// src/engine/driver.ts
export type DriverEvent = { seq: number; at: number; type: string; data: unknown }; // type は SDK の message.type か "permission_request" か "exited"
export interface Driver {
  readonly kind: Kind;
  readonly capabilities: Capabilities;
  readonly id: string;                 // Claude Code の session id
  summary(): SessionSummary;
  send(text: string): Promise<{ delivered: "stdin" | "socket" }>;
  events(): AsyncIterable<DriverEvent>; // 生きている間、順に出す
  pending(): PendingPermission[];
  answer(requestId: string, a: PermissionAnswer): Promise<void>; // capabilities.permissions が false なら throw
  interrupt(): Promise<void>;          // capabilities.interrupt が false なら throw
  setPermissionMode?(mode: string): Promise<void>; // NodeDriver だけが実装する。無ければ API は 409
  stop(): Promise<void>;
}
export class CapabilityError extends Error { constructor(public capability: keyof Capabilities) { super(`capability ${capability} not available`); } }
```

- [ ] **Step 1: 失敗する試験を書く**

```ts
// test/engine/driver.test.ts
import { test, expect } from "bun:test";
import { CapabilityError } from "../../src/engine/driver";
test("CapabilityError names the missing capability", () => {
  const e = new CapabilityError("interrupt");
  expect(e.capability).toBe("interrupt");
  expect(e.message).toContain("interrupt");
});
```

- [ ] **Step 2: 失敗を確かめる**

Run: `bun test test/engine/driver.test.ts`
Expected: FAIL（モジュールが無い）

- [ ] **Step 3: 上の型と`CapabilityError`を書く**

- [ ] **Step 4: 通ることを確かめる**

Run: `bun test test/engine/driver.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src test && git commit -m "feat(engine): Driver の境界と能力の型"
```

### Task 2: 台帳（sessions/store.ts）

**Files:**
- Create: `src/sessions/store.ts`
- Test: `test/sessions/store.test.ts`、`test/helpers/fake-driver.ts`

**Interfaces:**
- Consumes: Task 1の`Driver`、`DriverEvent`、`SessionSummary`。
- Produces:

```ts
export class SessionStore {
  add(d: Driver): void;                       // d.events() を読み始め、seq 付きでためる（上限は直近 2000 件）
  get(id: string): Driver | undefined;
  list(): SessionSummary[];                   // add した順
  remove(id: string): void;
  eventsSince(id: string, after: number): DriverEvent[];        // after より大きい seq
  subscribe(id: string, after: number): AsyncIterable<DriverEvent>; // ためた分を出してから、続きを待つ
  subscribeAll(): AsyncIterable<{ id: string; summary: SessionSummary }>; // 状態が変わるたび
}
```

```ts
// test/helpers/fake-driver.ts
export class FakeDriver implements Driver { /* push(event) で任意のイベントを流せ、pending と answer を記録する。capabilities はコンストラクタで指定 */ }
```

- [ ] **Step 1: 失敗する試験を書く**

```ts
test("subscribe replays events after the cursor then continues", async () => {
  const d = new FakeDriver({ id: "s1", capabilities: { send: true, permissions: true, interrupt: true } });
  const store = new SessionStore(); store.add(d);
  d.push({ type: "assistant", data: 1 }); d.push({ type: "assistant", data: 2 });
  const it = store.subscribe("s1", 1)[Symbol.asyncIterator]();
  expect((await it.next()).value.data).toBe(2);
  d.push({ type: "result", data: 3 });
  expect((await it.next()).value.data).toBe(3);
});
test("seq is strictly increasing per session", ...);
test("remove stops subscribers", ...);
test("subscribeAll emits when state changes", ...);
```

- [ ] **Step 2: 失敗を確かめる**

Run: `bun test test/sessions`
Expected: FAIL

- [ ] **Step 3: `SessionStore`と`FakeDriver`を書く**

購読は1本の非同期キューで作る（`Promise`の解決待ちを配列で持つ）。外部ライブラリは使わない。

- [ ] **Step 4: 通ることを確かめる**

Run: `bun test test/sessions`
Expected: PASS 4

- [ ] **Step 5: Commit**

```bash
git add src/sessions test && git commit -m "feat(sessions): メモリの台帳と SSE 用の購読"
```

### Task 3: NodeDriver（engine/node-driver.ts）

**Files:**
- Create: `src/engine/node-driver.ts`
- Test: `test/engine/node-driver.test.ts`、`test/helpers/fake-query.ts`

**Interfaces:**
- Consumes: Task 1の`Driver`。SDKの`query`、`Options`、`SDKUserMessage`、`CanUseTool`、`PermissionResult`、`Query`（`node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts`が正）。
- Produces:

```ts
export type QueryFn = typeof import("@anthropic-ai/claude-agent-sdk").query;
export type StartOptions = {
  cwd: string; prompt?: string; permissionMode?: PermissionMode; model?: string;
  resume?: string; fork?: boolean; settingSources?: SettingSource[]; mcpServers?: Record<string, unknown>;
};
export class NodeDriver implements Driver {
  static async start(opts: StartOptions, deps: { queryFn: QueryFn; nodeName: string }): Promise<NodeDriver>;
  // 中身: prompt は AsyncIterable<SDKUserMessage>（自前のキュー）。初回の prompt があればキューに入れる。
  // options: cwd、permissionMode、model、resume、forkSession、settingSources（既定は3つ全部）、includePartialMessages: true、
  //          canUseTool: 要求を pending に積み、answer() で解決する Promise を返す。
  // system/init の session_id を id にする。result のたびに usage を足す。生成器が終わったら state を exited にする。
}
```

- [ ] **Step 1: 失敗する試験を書く**

`fake-query.ts`は、渡された`prompt`の非同期イテラブルからuser行を読み、`system/init`（session_idは`"fake-session"`）、`assistant`、`result`を順に返す偽の`query`。`canUseTool`を呼ぶ版も作れる。

```ts
test("start yields session id from system/init", ...);               // id === "fake-session"
test("send pushes a user message the fake query receives", ...);     // fake が受けた content に送った文が入る
test("permission request is pending until answered", async () => {
  // fake が canUseTool("Write", {file_path:"x"}, ...) を呼ぶ。pending() が1件になり、answer(id, {behavior:"allow"}) で fake 側の Promise が allow で解決する
});
test("interrupt calls query.interrupt", ...);
test("generator end marks exited with reason", ...);                  // summary().state === "exited"
test("send after exit rejects", ...);
```

- [ ] **Step 2: 失敗を確かめる**

Run: `bun test test/engine/node-driver.test.ts`
Expected: FAIL

- [ ] **Step 3: `NodeDriver`を書く**

イベントはSDKのmessageをそのまま`DriverEvent.data`に入れ、`type`は`message.type`。権限要求は`type: "permission_request"`のイベントも流す（SSEで画面に出すため）。`stop()`は入力キューを閉じ、`abortController.abort()`を呼ぶ。

- [ ] **Step 4: 通ることを確かめる**

Run: `bun test test/engine/node-driver.test.ts`
Expected: PASS 6

- [ ] **Step 5: Commit**

```bash
git add src/engine test && git commit -m "feat(engine): SDK を包む NodeDriver（権限の保留と応答、中断、終了）"
```

### Task 4: 端末セッションの一覧（engine/agents.ts）

**Files:**
- Create: `src/engine/agents.ts`
- Test: `test/engine/agents.test.ts`、`test/fixtures/agents.json`

**Interfaces:**
- Produces:

```ts
export type AgentInfo = { pid?: number; cwd: string; kind: "interactive" | "background"; startedAt: number; sessionId?: string; name?: string; status?: "busy" | "waiting" | "idle"; waitingFor?: string };
export type Runner = (cmd: string[]) => Promise<{ stdout: string; code: number }>;
export async function listAgents(run: Runner): Promise<AgentInfo[]>;   // `claude agents --json` を実行して配列を返す。code が 0 以外なら []
export function socketPathFor(pid: number, uid: number): string[];     // 候補の順。`/tmp/cc-socks/<pid>.sock`、`/tmp/cc-socks-<uid>/<pid>.sock`
```

- [ ] **Step 1: 失敗する試験を書く**

`test/fixtures/agents.json`は実機の出力（2026-11-06のMac。pid 14356、kind interactive、sessionId、status busyを含む）。

```ts
test("listAgents parses the real json shape", ...);    // 3件、[0].pid === 14356、[0].kind === "interactive"
test("listAgents returns [] when the command fails", ...);
test("socketPathFor lists both candidate paths in order", ...);
```

- [ ] **Step 2: 失敗を確かめる**

Run: `bun test test/engine/agents.test.ts`
Expected: FAIL

- [ ] **Step 3: 書く**

- [ ] **Step 4: 通ることを確かめる**

Run: `bun test test/engine/agents.test.ts`
Expected: PASS 3

- [ ] **Step 5: Commit**

```bash
git add src/engine/agents.ts test && git commit -m "feat(engine): claude agents --json の一覧とソケットの場所"
```

### Task 5: TerminalDriver（engine/terminal-driver.ts）

**Files:**
- Create: `src/engine/terminal-driver.ts`
- Test: `test/engine/terminal-driver.test.ts`

**Interfaces:**
- Consumes: Task 1の`Driver`、Task 4の`AgentInfo`、`socketPathFor`。
- Produces:

```ts
export class TerminalDriver implements Driver {
  constructor(info: AgentInfo, deps: { uid: number; connect: (path: string) => Promise<{ write(line: string): Promise<void>; close(): void }> });
  // kind "terminal"、capabilities { send: true, permissions: false, interrupt: false }
  // send(text): 候補のソケットを順に試し、1行 JSON + "\n" を書いて閉じる。どれにも繋がらなければ SocketGoneError を投げる
  // events(): 空のイテラブル（端末セッションのイベントは流さない）。summary() は info から（state は status から。busy→running、waiting→waiting_permission、idle→idle）
}
export class SocketGoneError extends Error {}
```

- [ ] **Step 1: 失敗する試験を書く**

試験は`Bun.listen({ unix: path })`でソケットを立て、受けた1行を記録する。

```ts
test("send writes exactly one json line in the cross-session shape", async () => {
  // 受けた行 === JSON.stringify({type:"user",message:{role:"user",content:"hello"}}) + "\n"
});
test("send throws SocketGoneError when no candidate path connects", ...);
test("answer and interrupt throw CapabilityError", ...);
test("summary maps status to state", ...);
```

- [ ] **Step 2: 失敗を確かめる**

Run: `bun test test/engine/terminal-driver.test.ts`
Expected: FAIL

- [ ] **Step 3: 書く**

`connect`の既定実装は`Bun.connect({ unix: path, socket: {...} })`。試験では偽物を注入する。

- [ ] **Step 4: 通ることを確かめる**

Run: `bun test test/engine/terminal-driver.test.ts`
Expected: PASS 4

- [ ] **Step 5: Commit**

```bash
git add src/engine/terminal-driver.ts test && git commit -m "feat(engine): 受信ソケットに書く TerminalDriver"
```

### Task 6: 過去のセッション（engine/history.ts）

**Files:**
- Create: `src/engine/history.ts`
- Test: `test/engine/history.test.ts`

**Interfaces:**
- Consumes: SDKの`listSessions(options?: { dir?: string; limit?: number })`と`getSessionMessages(id, { dir?, limit?, offset? })`、`SDKSessionInfo`（`sessionId`、`summary`、`lastModified`、`customTitle`、`firstPrompt`）、`SessionMessage`（`type`、`uuid`、`session_id`、`message`、`parent_tool_use_id`）。
- Produces:

```ts
export type HistoryFns = { listSessions: typeof listSessions; getSessionMessages: typeof getSessionMessages };
export class History {
  constructor(fns: HistoryFns);
  async list(limit?: number): Promise<SessionSummary[]>;  // kind "node"、capabilities 全部 false、state "exited"、title は customTitle か summary
  async messages(id: string, after?: number): Promise<{ messages: SessionMessage[]; next?: number }>; // after は offset
}
```

- [ ] **Step 1: 失敗する試験を書く**

```ts
test("list maps SDKSessionInfo to SessionSummary", ...);     // id、title、lastActivityAt、capabilities が全部 false
test("messages passes offset as after and returns next", ...);
```

- [ ] **Step 2: 失敗を確かめる**

Run: `bun test test/engine/history.test.ts`
Expected: FAIL

- [ ] **Step 3: 書く**

- [ ] **Step 4: 通ることを確かめる**

Run: `bun test test/engine/history.test.ts`
Expected: PASS 2

- [ ] **Step 5: Commit**

```bash
git add src/engine/history.ts test && git commit -m "feat(engine): SDK から過去のセッションと会話を読む"
```

### Task 7: 呼び手（identity/）

**Files:**
- Create: `src/identity/identity.ts`、`src/identity/from-line.ts`
- Test: `test/identity/identity.test.ts`

**Interfaces:**
- Produces:

```ts
export type Caller = { id: string; via?: string };           // id は email か "agent:<名前>" か "local"
export interface Identity { callerOf(req: Request): Caller }
export class HeaderIdentity implements Identity {}           // x-cc-from と x-cc-via を読む。無ければ { id: "local" }
export function fromLine(c: Caller, nodeName: string): string;   // `from ${c.id} via ${c.via ?? nodeName}`
export function withFromLine(c: Caller, nodeName: string, text: string): string; // fromLine + "\n\n" + text
export function parseFromLine(text: string): Caller | undefined;  // 先頭行が from 行なら { id, via }。子認識の親はこれで導く
```

- [ ] **Step 1: 失敗する試験を書く**

```ts
test("HeaderIdentity reads x-cc-from and x-cc-via", ...);
test("HeaderIdentity defaults to local", ...);
test("withFromLine prefixes one line and a blank line", () => {
  expect(withFromLine({ id: "ceo@fybe.jp" }, "vm", "hi")).toBe("from ceo@fybe.jp via vm\n\nhi");
});
```

- [ ] **Step 2: 失敗を確かめる**

Run: `bun test test/identity`
Expected: FAIL

- [ ] **Step 3: 書く**

- [ ] **Step 4: 通ることを確かめる**

Run: `bun test test/identity`
Expected: PASS 3

- [ ] **Step 5: Commit**

```bash
git add src/identity test && git commit -m "feat(identity): 呼び手のヘッダと from 行"
```

### Task 8: HTTPとSSE（api/）

**Files:**
- Create: `src/api/app.ts`、`src/api/sessions.ts`、`src/api/host.ts`、`src/api/sse.ts`、`src/api/errors.ts`
- Test: `test/api/app.test.ts`

**Interfaces:**
- Consumes: Task 2の`SessionStore`、Task 3の`NodeDriver.start`、Task 4の`listAgents`、Task 5の`TerminalDriver`、Task 6の`History`、Task 7の`Identity`と`withFromLine`。
- Produces:

```ts
export type Deps = {
  nodeName: string; roots: string[]; store: SessionStore; identity: Identity; history: History;
  startNode: (opts: StartOptions) => Promise<NodeDriver>;             // 試験では偽物
  agents: () => Promise<AgentInfo[]>; terminalFor: (a: AgentInfo) => Driver;
  host: () => Promise<{ claudeVersion: string; account?: string; rateLimit?: unknown; load: number[] }>;
};
export function createApp(deps: Deps): { fetch(req: Request): Promise<Response> };
```

経路と応答（仕様1.2のとおり）。

| 経路 | 応答 |
| --- | --- |
| GET /api/host | `{ name, claudeVersion, account, rateLimit, roots, load }` |
| GET /api/sessions?parent= | 台帳の生きているもの、`agents()`の端末（台帳に無いpid）、`history.list()`の過去（台帳と重複するidは除く）。`SessionSummary[]`。`parent`は、生きているものは作成時の呼び手、過去のものは`firstPrompt`の先頭の`from <呼び手> via`から`parseFromLine(text): Caller | undefined`（identity/from-line.ts）で導く。`?parent=`があれば一致するものだけ |
| GET /api/sessions/:id | `{ ...summary, pending: PendingPermission[] }`。無ければ404 |
| GET /api/sessions/:id/messages?after= | 生きていれば`store.eventsSince`、無ければ`history.messages` |
| GET /api/sessions/:id/events?after= | SSE。`store.subscribe(id, after)`。`id: <seq>`、`event: <type>`、`data: <json>`。15秒ごとに`: keep-alive` |
| GET /api/events | SSE。`store.subscribeAll()` |
| POST /api/sessions | body `StartOptions`。cwdがrootsの下に無いか存在しなければ400。`startNode` → `store.add` → 201 `{ id }` |
| POST /api/sessions/:id/messages | body `{ text }`。`driver.send(withFromLine(caller, nodeName, text))`。200 `{ delivered }`。能力が無ければ409、exitedなら409 `{ hint: "resume" }`、SocketGoneErrorなら410 |
| POST /api/sessions/:id/permissions/:rid | body `PermissionAnswer`。能力が無ければ409、ridが無ければ404 |
| POST /api/sessions/:id/interrupt | 能力が無ければ409 |
| PATCH /api/sessions/:id | body `{ permissionMode? }`。NodeDriverだけ。他は409 |
| DELETE /api/sessions/:id | `driver.stop()` → `store.remove`。204 |

- [ ] **Step 1: 失敗する試験を書く**

`createApp`に`FakeDriver`と偽の`startNode`、`agents`、`history`を渡し、`app.fetch(new Request("http://127.0.0.1/api/..."))`で試験する。ネットワークは使わない。

```ts
test("GET /api/sessions merges live, terminal and history without duplicates", ...);
test("GET /api/sessions?parent=agent:lead returns only sessions whose first prompt names that parent", ...);
test("POST /api/sessions rejects cwd outside roots with 400", ...);
test("POST messages prefixes the from line and returns delivered", ...);   // FakeDriver が受けた text が "from local via vm\n\nhi"
test("POST permissions on a terminal session is 409", ...);
test("POST messages on an exited session is 409 with hint resume", ...);
test("GET events replays after the cursor as SSE frames", ...);            // body の先頭が "id: 2\nevent: assistant\ndata: " で始まる
test("pending permission shows in GET /api/sessions/:id", ...);
test("POST messages when the socket is gone is 410", ...);
```

- [ ] **Step 2: 失敗を確かめる**

Run: `bun test test/api`
Expected: FAIL

- [ ] **Step 3: 書く**

ルーティングは`URL.pathname`を`/`で割って手で振り分ける。フレームワークは入れない。エラーは`errors.ts`の`HttpError(status, body)`に統一する。SSEは`ReadableStream`で作り、クライアントが切れたら購読を止める。

- [ ] **Step 4: 通ることを確かめる**

Run: `bun test test/api`
Expected: PASS 8

- [ ] **Step 5: Commit**

```bash
git add src/api test && git commit -m "feat(api): セッションの監視と管理の HTTP と SSE"
```

### Task 9: 組み立てと設定（main.ts、config.ts）

**Files:**
- Create: `src/main.ts`、`src/config.ts`、`scripts/smoke.sh`
- Test: `test/config.test.ts`、`test/live.test.ts`（`CC_LIVE=1`のときだけ）

**Interfaces:**
- Produces: `bun run src/main.ts`が`http://127.0.0.1:<port>`で待つ。`loadConfig(path?: string): Config`、`Config = { name: string; port: number; roots: string[] }`。

- [ ] **Step 1: 失敗する試験を書く**

```ts
test("loadConfig falls back to hostname, 4322 and $HOME", ...);
test("loadConfig reads name, port, roots from cc.json", ...);
```

`test/live.test.ts`（`CC_LIVE`が無ければ`test.skip`）。

```ts
test("live: create, read result over SSE, send, permission allow, interrupt, stop, resume", async () => {
  // 本物の startNode で cwd = os.tmpdir() の下の空ディレクトリ。prompt "reply with the single word ok"。
  // SSE で result を受ける。次に "create a file x.txt with hello" を送り、permission_request を待ち、allow で答え、ファイルができることを確かめる。
  // DELETE の後、resume で同じ id を指定して "what did you create" が通る。
});
```

- [ ] **Step 2: 失敗を確かめる**

Run: `bun test test/config.test.ts`
Expected: FAIL

- [ ] **Step 3: 書く**

`main.ts`が唯一の組み立て場所。`query`と`listSessions`と`getSessionMessages`はSDKから、`Runner`は`Bun.spawn`、`connect`は`Bun.connect`、`Identity`は`HeaderIdentity`。`Bun.serve({ hostname: "127.0.0.1", port, fetch: app.fetch })`。`scripts/smoke.sh`はcurlで、host、sessionsの作成、SSEの先頭数行、messages、DELETEを順に叩く。

- [ ] **Step 4: 通ることを確かめる**

Run: `bun test`（live以外）
Expected: PASS（全部）

Run（VMで）: `orb run -m ubuntu bash -lc 'cd /private/tmp/cc-web && CC_LIVE=1 bun test test/live.test.ts'`
Expected: PASS 1（初回はbunの導入が要る。`curl -fsSL https://bun.sh/install | bash`）

- [ ] **Step 5: Commit**

```bash
git add src/main.ts src/config.ts scripts test && git commit -m "feat: 組み立てと設定、VM での live 試験"
```

### Task 10: 実機で一通り（仕様の試作1と2）

**Files:**
- Create: `docs/results/2026-11-06-protocol-smoke.md`

- [ ] **Step 1: VMでノードを立てる**

Run: `orb run -m ubuntu bash -lc 'cd /private/tmp/cc-web && bun run src/main.ts'`（バックグラウンド）
Expected: `node on http://127.0.0.1:4322`

- [ ] **Step 2: curlで一通り**

Run: `orb run -m ubuntu bash scripts/smoke.sh`
Expected: hostがclaudeの版を返す。作成が201。SSEに`event: system`と`event: result`。送信が200 `{ "delivered": "stdin" }`。DELETEが204。

- [ ] **Step 3: 端末セッションへの注入（Macで）**

Macでノードを別ポートで立て、`GET /api/sessions`にkind terminalの行が出ること、`POST /api/sessions/<id>/messages`が200 `{ "delivered": "socket" }`で、その端末に「別セッションからのメッセージ」として届くことを目で確かめる。

- [ ] **Step 4: 結果を残す**

`docs/results/2026-11-06-protocol-smoke.md`に、実行したコマンド、応答、届いた画面の文言、かかった時間を書く。

- [ ] **Step 5: Commit**

```bash
git add docs && git commit -m "docs: VM と Mac でのプロトコルの疎通結果"
```
