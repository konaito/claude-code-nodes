// エンジンの境界。1つのセッションを動かす Driver の契約。実装は NodeDriver（SDK）、TerminalDriver（受信ソケット）、PtyDriver（PTY の対話 claude）
import type { Capabilities, Kind, PendingPermission, PermissionAnswer, SessionSummary } from "../sessions/types";

// Driver が出す生のイベント。seq は台帳（SessionStore）が振る
export type RawEvent = { at: number; type: string; data: unknown };
export type DriverEvent = RawEvent & { seq: number };
// 起動の後に替えられる設定。どちらも省ける
export type SessionConfig = { model?: string; permissionMode?: string };
export const PERMISSION_MODES = ["default", "acceptEdits", "bypassPermissions", "plan", "dontAsk", "auto"] as const;

export interface Driver {
  readonly kind: Kind;
  readonly capabilities: Capabilities;
  readonly id: string; // Claude Code の session id
  summary(): SessionSummary;
  send(text: string): Promise<{ delivered: "stdin" | "socket" | "pty" }>;
  events(): AsyncIterable<RawEvent>; // 生きている間、順に出す。消費者は台帳（SessionStore）1つだけの前提
  pending(): PendingPermission[];
  answer(requestId: string, a: PermissionAnswer): Promise<void>; // capabilities.permissions が false なら throw
  interrupt(): Promise<void>; // capabilities.interrupt が false なら throw
  setPermissionMode?(mode: string): Promise<void>; // NodeDriver だけが実装する。無ければ API は 409
  // モデルと権限モードを替える（PATCH /api/sessions/<id>、#64）。node は SDK の setModel と setPermissionMode、pty は同じ id で claude を起動し直す。
  // 無ければ API は 409。pty は待機中でなければ BusyError
  configure?(c: SessionConfig): Promise<void>;
  // 組み込みコマンド（/compact、/context など）を from 行を付けずに送る（POST /api/sessions/<id>/command、#64）。
  // from は送り手で、台帳に command のイベントとして残す。無ければ API は 409
  command?(text: string, from: string): Promise<{ delivered: "stdin" | "pty" }>;
  stop(reason?: string): Promise<void>; // reason は終わった理由（exitReason と exited の reason）。無ければ Driver が決める
  // 引き継ぎ（src/api/sessions.ts の succeed）が使う。node と pty が実装する
  setParent?(parent: string): void;             // summary の parent を付け替える。前任の子を後継の子にする
  started?(timeoutMs: number): Promise<boolean>; // claude が起動した印を待つ。出れば true、先に終わるか時間切れなら false。無いものは待たない
  // 手が空いた子を止める仕組み（src/sessions/idle-stop.ts）が使う。無いものは数えない
  viewers?(): number;              // 今つながっている端末の画面の数。0 より多い間は止めない
  idleSince?(): number;            // summary の lastActivityAt に数えない動き（端末の画面の接続と切断）の最後の時刻
  confirmIdle?(): Promise<boolean>; // 止める直前に、本体がまだ待機中かを確かめる。false なら止めない
}

export class CapabilityError extends Error {
  constructor(public capability: keyof Capabilities) {
    super(`capability ${capability} not available`);
    this.name = "CapabilityError";
  }
}
// 境界の例外。api/errors.ts はここだけを見て状態コードに変える
export class ExitedError extends Error { constructor(reason?: string) { super(`session exited${reason ? `: ${reason}` : ""}`); this.name = "ExitedError"; } }
// 今は受けられない（PTY のセッションが承認画面を出している間の send など）。409
export class BusyError extends Error { constructor(msg: string) { super(msg); this.name = "BusyError"; } }
// pty の configure で、新しい設定の claude が起動しなかった。rolledBack なら前の設定で起動し直してあり、セッションは続く。502
export class RestartFailedError extends Error { constructor(msg: string, public rolledBack: boolean) { super(msg); this.name = "RestartFailedError"; } }
// このセッションでは打てないコマンド（pty の /effort など、設定ファイルに保存されてしまうもの）。409
export class CommandRefusedError extends Error { constructor(public code: string, msg: string) { super(msg); this.name = "CommandRefusedError"; } }
export class NotFoundError extends Error { constructor(msg: string) { super(msg); this.name = "NotFoundError"; } }
export class SocketGoneError extends Error {
  constructor(paths: string[]) { super(`no inbox socket: ${paths.join(", ") || "(no pid)"}`); this.name = "SocketGoneError"; }
}
