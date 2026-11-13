// エージェントが立てた子を、手が空いたら止める（#44）。親が止め忘れた子が Claude Town に残り続けるため。
// 対象は parent が `agent:` で始まる node と pty のセッション。ターンが終わって idle のまま timeoutMs 何もなければ stop する。会話は残り、resume で戻せる。
// タイマーはセッションごとに1本だけ持つ。台帳（SessionStore）が idle になったときに arm を呼び、発火したら最後の動きからの時間を見て、足りなければ残りの時間で張り直す
import type { Driver } from "../engine/driver";
import type { SessionSummary } from "./types";

export const DEFAULT_IDLE_STOP_MS = 10 * 60_000;
// 止めた理由の頭。exitReason がこれで始まれば、ノードが自動で止めた
export const IDLE_STOP_PREFIX = "idle-stop:";
export const idleStopReason = (ms: number, id: string) => `${IDLE_STOP_PREFIX} no activity for ${Math.round(ms / 60_000 * 10) / 10} min; the conversation is kept, continue with create_session resume=${id}`;
export const isIdleStopped = (s: Pick<SessionSummary, "state" | "exitReason">) => s.state === "exited" && !!s.exitReason?.startsWith(IDLE_STOP_PREFIX);

// 自動で止めてよいセッションか。人が立てたもの（local、email）と端末のセッションは止めない。1通目を待っているもの（claude を起動していない）は台帳の30分の掃除に任せる
export function idleStoppable(s: SessionSummary): boolean {
  return (s.kind === "node" || s.kind === "pty") && !!s.parent?.startsWith("agent:") && s.capabilities.stop && !s.awaitingFirst;
}

export type IdleStopDeps = {
  timeoutMs: number;
  alive: (d: Driver) => boolean; // 台帳にまだこの Driver が載っていて、終わっていない
  now?: () => number;
};

export class IdleStop {
  private timers = new Map<string, { d: Driver; t: ReturnType<typeof setTimeout> }>();
  private now: () => number;
  constructor(private deps: IdleStopDeps) { this.now = deps.now ?? Date.now; }

  // idle になったときに呼ぶ。対象でなければ何もしない
  arm(d: Driver, ms = this.deps.timeoutMs) {
    this.forget(d.id);
    if (this.deps.timeoutMs <= 0 || !idleStoppable(d.summary())) return;
    const t = setTimeout(() => { this.timers.delete(d.id); void this.fire(d).catch((e) => console.error(`session ${d.id}: idle stop failed:`, e)); }, Math.max(ms, 0));
    (t as { unref?: () => void }).unref?.();
    this.timers.set(d.id, { d, t });
  }
  forget(id: string) {
    const x = this.timers.get(id);
    if (x) { clearTimeout(x.t); this.timers.delete(id); }
  }
  get size() { return this.timers.size; }

  private lastMove(d: Driver): number { return Math.max(d.summary().lastActivityAt, d.idleSince?.() ?? 0); }

  private async fire(d: Driver) {
    if (!this.deps.alive(d)) return;
    const s = d.summary();
    // 作業中と承認待ちは止めない。次に idle になったときに台帳がまた arm する
    if (s.state !== "idle" || !idleStoppable(s)) return;
    // 人が端末を開いている間は止めない。閉じたら最後の動きとして数える
    if ((d.viewers?.() ?? 0) > 0) return this.arm(d);
    const last = this.lastMove(d);
    const left = last + this.deps.timeoutMs - this.now();
    if (left > 0) return this.arm(d, left);
    // pty の state は hooks 頼みでずれることがあるので、止める前に claude 本体の状態を1回確かめる
    if (d.confirmIdle && !(await d.confirmIdle())) return this.arm(d);
    // 確かめている間に文が届いたり端末が開いたりしたら止めない
    if (!this.deps.alive(d) || d.summary().state !== "idle" || this.lastMove(d) !== last || (d.viewers?.() ?? 0) > 0) {
      if (this.deps.alive(d) && d.summary().state === "idle") this.arm(d);
      return;
    }
    await d.stop(idleStopReason(this.deps.timeoutMs, d.id));
  }
}
