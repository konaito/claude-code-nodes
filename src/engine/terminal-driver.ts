// 受信ソケットに書く TerminalDriver。人が端末で起動した対話セッションに、公式の入口（cross-session messaging のソケット）から文を届ける。能力は send だけ
import type { Driver, RawEvent } from "./driver";
import { CapabilityError, SocketGoneError } from "./driver";
export { SocketGoneError } from "./driver";
import type { AgentInfo } from "./agents";
import { socketPathFor } from "./agents";
import type { PendingPermission, PermissionAnswer, SessionSummary, State } from "../sessions/types";

export type Conn = { write(line: string): Promise<void>; close(): void };
export type Connect = (path: string) => Promise<Conn>;
export type TerminalDeps = { uid: number; connect: Connect; socketPaths?: (pid: number, uid: number) => string[] };

export const unixConnect: Connect = (path) =>
  new Promise((resolve, reject) => {
    Bun.connect({
      unix: path,
      socket: {
        open(s) { resolve({ write: async (line) => { s.write(line); }, close: () => s.end() }); },
        error(_s, e) { reject(e); },
        connectError(_s, e) { reject(e); },
        data() {},
        close() {},
      },
    }).catch(reject);
  });

const stateOf = (status?: AgentInfo["status"]): State =>
  status === "busy" ? "running" : status === "waiting" ? "waiting_permission" : "idle";

export class TerminalDriver implements Driver {
  readonly kind = "terminal" as const;
  readonly capabilities = { send: true, permissions: false, interrupt: false, stop: false, events: false };
  readonly id: string;
  constructor(private info: AgentInfo, private deps: TerminalDeps) {
    this.id = info.sessionId ?? `pid-${info.pid ?? 0}`;
  }
  summary(): SessionSummary {
    return {
      id: this.id, kind: this.kind, capabilities: this.capabilities, cwd: this.info.cwd, state: stateOf(this.info.status),
      startedAt: this.info.startedAt, lastActivityAt: this.info.startedAt, pid: this.info.pid, title: this.info.name,
    };
  }
  async send(text: string) {
    const paths = this.info.pid == null ? [] : (this.deps.socketPaths ?? socketPathFor)(this.info.pid, this.deps.uid);
    for (const p of paths) {
      let c: Conn;
      try { c = await this.deps.connect(p); } catch { continue; }
      try { await c.write(JSON.stringify({ type: "user", message: { role: "user", content: text } }) + "\n"); } finally { c.close(); }
      return { delivered: "socket" as const };
    }
    throw new SocketGoneError(paths);
  }
  events(): AsyncIterable<RawEvent> { return { async *[Symbol.asyncIterator]() {} }; }
  pending(): PendingPermission[] { return []; }
  async answer(_id: string, _a: PermissionAnswer): Promise<void> { throw new CapabilityError("permissions"); }
  async interrupt(): Promise<void> { throw new CapabilityError("interrupt"); }
  async stop(): Promise<void> {}
}
