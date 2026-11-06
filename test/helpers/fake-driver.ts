// 試験用の偽の Driver。push() で任意のイベントを流し、pending と answer を記録する
import type { Driver, RawEvent } from "../../src/engine/driver";
import { CapabilityError } from "../../src/engine/driver";
import type { Capabilities, Kind, PendingPermission, PermissionAnswer, SessionSummary, State } from "../../src/sessions/types";

export class FakeDriver implements Driver {
  readonly kind: Kind;
  readonly capabilities: Capabilities;
  readonly id: string;
  cwd = "/tmp/fake";
  state: State = "running";
  sent: string[] = [];
  answers: Array<{ requestId: string; a: PermissionAnswer }> = [];
  interrupts = 0;
  pendingList: PendingPermission[] = [];
  private queue: RawEvent[] = [];
  private waiters: Array<(v: IteratorResult<RawEvent>) => void> = [];
  private closed = false;

  constructor(opts: { id: string; capabilities: Capabilities; kind?: Kind }) {
    this.id = opts.id;
    this.capabilities = opts.capabilities;
    this.kind = opts.kind ?? "node";
  }
  push(e: { type: string; data: unknown }) {
    const ev: RawEvent = { at: Date.now(), ...e };
    const w = this.waiters.shift();
    if (w) w({ value: ev, done: false });
    else this.queue.push(ev);
  }
  setState(s: State) { this.state = s; }
  summary(): SessionSummary {
    return { id: this.id, kind: this.kind, capabilities: this.capabilities, cwd: this.cwd, state: this.state, startedAt: 0, lastActivityAt: 0 };
  }
  async send(text: string) { this.sent.push(text); return { delivered: "stdin" as const }; }
  events(): AsyncIterable<RawEvent> {
    const self = this;
    return {
      [Symbol.asyncIterator]() {
        return {
          next(): Promise<IteratorResult<RawEvent>> {
            if (self.queue.length) return Promise.resolve({ value: self.queue.shift()!, done: false });
            if (self.closed) return Promise.resolve({ value: undefined as any, done: true });
            return new Promise((resolve) => self.waiters.push(resolve));
          },
        };
      },
    };
  }
  pending() { return this.pendingList; }
  async answer(requestId: string, a: PermissionAnswer) {
    if (!this.capabilities.permissions) throw new CapabilityError("permissions");
    this.answers.push({ requestId, a });
    this.pendingList = this.pendingList.filter((p) => p.requestId !== requestId);
  }
  async interrupt() {
    if (!this.capabilities.interrupt) throw new CapabilityError("interrupt");
    this.interrupts++;
  }
  async stop() {
    this.closed = true;
    this.state = "exited";
    for (const w of this.waiters.splice(0)) w({ value: undefined as any, done: true });
  }
}
