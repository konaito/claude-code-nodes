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
  // プロンプト無しで立てて、まだ1通も届いていない（claude は起動していない）。届けば消える
  awaitingFirst?: boolean;
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
