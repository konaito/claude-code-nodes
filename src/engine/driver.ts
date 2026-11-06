// エンジンの境界。1つのセッションを動かす Driver の契約。実装は NodeDriver（SDK）と TerminalDriver（受信ソケット）
import type { Capabilities, Kind, PendingPermission, PermissionAnswer, SessionSummary } from "../sessions/types";

// Driver が出す生のイベント。seq は台帳（SessionStore）が振る
export type RawEvent = { at: number; type: string; data: unknown };
export type DriverEvent = RawEvent & { seq: number };

export interface Driver {
  readonly kind: Kind;
  readonly capabilities: Capabilities;
  readonly id: string; // Claude Code の session id
  summary(): SessionSummary;
  send(text: string): Promise<{ delivered: "stdin" | "socket" }>;
  events(): AsyncIterable<RawEvent>; // 生きている間、順に出す。消費者は台帳（SessionStore）1つだけの前提
  pending(): PendingPermission[];
  answer(requestId: string, a: PermissionAnswer): Promise<void>; // capabilities.permissions が false なら throw
  interrupt(): Promise<void>; // capabilities.interrupt が false なら throw
  setPermissionMode?(mode: string): Promise<void>; // NodeDriver だけが実装する。無ければ API は 409
  stop(): Promise<void>;
}

export class CapabilityError extends Error {
  constructor(public capability: keyof Capabilities) {
    super(`capability ${capability} not available`);
    this.name = "CapabilityError";
  }
}
// 境界の例外。api/errors.ts はここだけを見て状態コードに変える
export class ExitedError extends Error { constructor(reason?: string) { super(`session exited${reason ? `: ${reason}` : ""}`); this.name = "ExitedError"; } }
export class NotFoundError extends Error { constructor(msg: string) { super(msg); this.name = "NotFoundError"; } }
export class SocketGoneError extends Error {
  constructor(paths: string[]) { super(`no inbox socket: ${paths.join(", ") || "(no pid)"}`); this.name = "SocketGoneError"; }
}
