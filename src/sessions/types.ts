// セッションの型。API は種類（kind）ではなく能力（capabilities）で振る舞いを決める
export type Kind = "node" | "terminal" | "pty"; // pty はノードが PTY で動かす対話の claude（src/engine/pty-driver.ts）
// terminal は端末の口（/terminal、/terminal/input、/terminal/resize）。PTY のセッションだけが持つ
export type Capabilities = { send: boolean; permissions: boolean; interrupt: boolean; stop: boolean; events: boolean; terminal?: boolean };
export type State = "running" | "waiting_permission" | "idle" | "exited";

export type SessionSummary = {
  id: string;
  kind: Kind;
  capabilities: Capabilities;
  cwd: string;
  state: State;
  startedAt: number;
  lastActivityAt: number;
  model?: string;
  permissionMode?: string;
  usage?: { inputTokens: number; outputTokens: number; costUsd: number };
  exitReason?: string;
  pid?: number;
  title?: string;
  // 最初の文の from 行の呼び手（"agent:<名前>" か email）。子認識。親側には何も持たない
  parent?: string;
  // 深さ（人が立てたものが0、子が1、孫が2）。このノードが作ったときに刻んだ値で、生きているものだけ持つ（src/api/depth.ts）
  depth?: number;
  // プロンプト無しで立てて、まだ1通も届いていない（claude は起動していない）。届けば消える
  awaitingFirst?: boolean;
  // どのアカウントで動いているか。cam のコマンド名と、その email（src/engine/account.ts）。
  // pty と node はノードが起動のときに選んだもの（node は claude を起動してから載る）。端末のセッションはプロセスの環境から読めたときだけ。
  // cam で選べずノードの設定で起動したものと、過去のセッションには無い
  account?: string;
  accountEmail?: string;
};

export type PendingPermission = {
  requestId: string;
  toolName: string;
  input: Record<string, unknown>;
  description?: string;
  suggestions?: unknown[];
  createdAt: number;
};

export type PermissionAnswer =
  | { behavior: "allow"; updatedInput?: Record<string, unknown>; updatedPermissions?: unknown[] }
  | { behavior: "deny"; message: string };
