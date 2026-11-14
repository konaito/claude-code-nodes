// メモリの台帳。Driver を登録し、イベントに seq を振ってため、SSE 用の購読を出す。ファイルには何も書かない
import type { Driver, DriverEvent } from "../engine/driver";
import type { SessionSummary } from "./types";
import { AsyncQueue } from "./async-queue";
import { IdleStop } from "./idle-stop";

const DEFAULT_MAX_EVENTS = 2000;
const KEEP_AFTER_EXIT = 50; // 終了後に残す末尾の件数。遅れて繋いだ購読者が終わりの理由を読めるように
const DEFAULT_ENDED_TTL_MS = 30 * 60_000; // 終わったセッションを台帳に残す時間。過ぎたら消す（過去の会話は履歴から読める）
const DEFAULT_MAX_ENDED = 100;            // 終わったセッションを残す件数の上限。超えたら古いものから消す
const DEFAULT_UNSENT_TTL_MS = 30 * 60_000; // プロンプト無しで立てて1通も届かないセッションを残す時間。終わったものと同じ30分
const REASONS_MAX = 256; // 台帳から掃いた後も覚えておく終わりの理由の件数。親が数時間後に読んでも、なぜ終わったかが分かるように
// 台帳の番号の印（epoch）。ノードのプロセスごとに変わる部分と、add のたびに増える部分でできている。
// 同じ印の間だけ seq が続いている。印が変わったら、読み手は持っている cursor を捨てて after=0 から読み直す
const BOOT = Date.now().toString(36);
let epochs = 0;
type Change = { id: string; summary: SessionSummary };
// 台帳がイベントに seq を振った直後に呼ぶ。stream_event は渡さない。親への知らせ（src/sessions/notify-parent.ts）が使う
export type EventListener = (d: Driver, ev: DriverEvent) => void;
type Entry = {
  driver: Driver;
  events: DriverEvent[];
  seq: number;        // この id で最後に振った番号。同じ id を入れ直しても引き継ぐ
  historyBase: number; // これより前の番号は台帳に無く、会話の履歴（jsonl）の位置で数える。付けた時点の履歴の件数（pty の resume）。無ければ 0
  trimmedTo: number;  // 上限超えで捨てた最後の seq。これ以前のカーソルは欠落がある
  epoch: string;      // この項目の番号の印。add のたびに新しくする（入れ直すと前のイベントは消え、resume では historyBase より前が jsonl の位置になるので、前の cursor は続かない）
  ended: boolean;
  endedAt?: number;
  subs: Set<AsyncQueue<DriverEvent>>;
  lastState: string;
};

export class SessionStore {
  private entries = new Map<string, Entry>();
  private allSubs = new Set<AsyncQueue<Change>>();
  private maxEvents: number;
  private lastRateLimit: unknown;
  private endedTtlMs: number;
  private maxEnded: number;
  private unsentTtlMs: number;
  private now: () => number;
  private idle?: IdleStop;
  private reasons = new Map<string, string>(); // 台帳から掃いたセッションの exitReason
  private listeners = new Set<EventListener>();
  private quieted = false;

  // idleStopMs を渡すと、エージェントが立てた子が idle のままその時間を過ぎたら止める（src/sessions/idle-stop.ts）。0 か無ければ止めない
  constructor(opts: { maxEvents?: number; endedTtlMs?: number; maxEnded?: number; unsentTtlMs?: number; now?: () => number; idleStopMs?: number } = {}) {
    this.maxEvents = opts.maxEvents ?? DEFAULT_MAX_EVENTS;
    this.endedTtlMs = opts.endedTtlMs ?? DEFAULT_ENDED_TTL_MS;
    this.unsentTtlMs = opts.unsentTtlMs ?? DEFAULT_UNSENT_TTL_MS;
    this.maxEnded = opts.maxEnded ?? DEFAULT_MAX_ENDED;
    this.now = opts.now ?? Date.now;
    if (opts.idleStopMs && opts.idleStopMs > 0) {
      this.idle = new IdleStop({ timeoutMs: opts.idleStopMs, now: this.now, alive: (d) => { const e = this.entries.get(d.id); return !!e && e.driver === d && !e.ended; } });
    }
  }
  // イベントの購読。台帳に載っている間のイベントだけを渡す（入れ直しや掃除で外れた Driver の分は渡さない）。外すときは返り値を呼ぶ
  onEvent(fn: EventListener): () => void { this.listeners.add(fn); return () => { this.listeners.delete(fn); }; }
  // ノードが止まるときに呼ぶ。以後は onEvent の購読に何も渡さない（止める途中の exited を親に知らせないため）
  quiet() { this.quieted = true; }
  // 台帳から掃いた後の終わりの理由。一覧と詳細が履歴の分に重ねる
  exitReasonOf(id: string): string | undefined { return this.reasons.get(id); }

  // historyBase を渡すと、番号をそこから振る（入れ直しで前の番号のほうが大きければ前の番号から）。
  // historyBase より前の位置は履歴の件数で数える（api/sessions.ts の messages が jsonl から返す）
  add(d: Driver, opts: { historyBase?: number } = {}) {
    this.sweep();
    const old = this.entries.get(d.id);
    if (old) { for (const s of old.subs) s.close(); old.subs.clear(); }
    const historyBase = Math.max(0, opts.historyBase ?? 0);
    const e: Entry = { driver: d, events: [], seq: Math.max(old?.seq ?? 0, historyBase), historyBase, trimmedTo: old?.trimmedTo ?? 0, epoch: `${BOOT}.${++epochs}`, ended: false, subs: new Set(), lastState: d.summary().state };
    this.entries.set(d.id, e);
    this.reasons.delete(d.id);
    if (e.lastState === "idle") this.idle?.arm(d);
    this.emitChange(d);
    void this.pump(e);
  }
  get(id: string): Driver | undefined { return this.entries.get(id)?.driver; }
  list(): SessionSummary[] { this.sweep(); return [...this.entries.values()].map((e) => e.driver.summary()); }
  // この id で最後に振った seq（stream_event を含む）。送る前の末尾として CLI に返す
  lastSeq(id: string): number | undefined { return this.entries.get(id)?.seq; }
  // add で渡した historyBase。これより前の after は履歴の位置
  historyBase(id: string): number { return this.entries.get(id)?.historyBase ?? 0; }
  // 番号の印。messages の応答に入れる
  epoch(id: string): string | undefined { return this.entries.get(id)?.epoch; }
  remove(id: string) {
    const e = this.entries.get(id);
    if (!e) return;
    this.entries.delete(id);
    this.idle?.forget(id);
    for (const s of e.subs) s.close();
    e.subs.clear();
    this.emitChange(e.driver);
  }
  eventsSince(id: string, after: number): DriverEvent[] {
    return this.must(id).events.filter((ev) => ev.seq > after);
  }
  trimmedTo(id: string): number { return this.must(id).trimmedTo; }
  // 全セッションで最後に流れた rate_limit_event の data（アカウントの枠はノードで1つ）
  rateLimit(): unknown { return this.lastRateLimit; }
  subscribe(id: string, after: number): AsyncIterable<DriverEvent> {
    const e = this.must(id);
    const q = new AsyncQueue<DriverEvent>();
    for (const ev of this.eventsSince(id, after)) q.push(ev);
    if (e.ended) { q.close(); return q; }
    e.subs.add(q);
    q.onClose = () => e.subs.delete(q);
    return q;
  }
  subscribeAll(): AsyncIterable<Change> {
    const q = new AsyncQueue<Change>();
    this.allSubs.add(q);
    q.onClose = () => this.allSubs.delete(q);
    return q;
  }

  private must(id: string): Entry {
    const e = this.entries.get(id);
    if (!e) throw new Error(`unknown session: ${id}`);
    return e;
  }
  // 終わってから endedTtlMs を過ぎたものと、maxEnded を超えた古いものを消す。タイマーは持たず、add と list のついでに掃く。
  // プロンプト無しで立てて1通も届かないまま unsentTtlMs を過ぎたもの（画面で開いて打たずに離れたもの）も止めて消す。claude は起動していないので、消えるのは台帳の項目だけ
  private sweep() {
    const t0 = this.now();
    for (const [id, e] of [...this.entries]) {
      const s = e.driver.summary();
      if (!e.ended && s.awaitingFirst && t0 - s.startedAt >= this.unsentTtlMs) {
        this.entries.delete(id);
        for (const q of e.subs) q.close();
        e.subs.clear();
        void e.driver.stop().catch(() => {});
        this.emitChange(e.driver);
      }
    }
    const ended = [...this.entries.entries()].filter(([, e]) => e.ended).sort((a, b) => (a[1].endedAt ?? 0) - (b[1].endedAt ?? 0));
    const t = this.now();
    ended.forEach(([id, e], i) => {
      if (t - (e.endedAt ?? t) >= this.endedTtlMs || ended.length - i > this.maxEnded) {
        this.entries.delete(id);
        const reason = e.driver.summary().exitReason;
        if (reason) { this.reasons.delete(id); this.reasons.set(id, reason); if (this.reasons.size > REASONS_MAX) this.reasons.delete(this.reasons.keys().next().value!); }
      }
    });
  }
  private emitChange(d: Driver) {
    const c = { id: d.id, summary: d.summary() };
    for (const s of this.allSubs) s.push(c);
  }
  private async pump(e: Entry) {
    try {
      for await (const raw of e.driver.events()) {
        if (this.entries.get(e.driver.id) !== e) break;
        e.seq++;
        const ev: DriverEvent = { ...raw, seq: e.seq };
        if (raw.type === "rate_limit_event") this.lastRateLimit = raw.data;
        // stream_event（トークンごとの断片）は番号は振るが、ためない。生きている購読にだけ流す
        if (raw.type !== "stream_event") {
          e.events.push(ev);
          while (e.events.length > this.maxEvents) e.trimmedTo = e.events.shift()!.seq;
        }
        for (const s of e.subs) s.push(ev);
        const st = e.driver.summary().state;
        if (st !== e.lastState) {
          e.lastState = st;
          if (st === "idle") this.idle?.arm(e.driver);
          else this.idle?.forget(e.driver.id);
          this.emitChange(e.driver);
        }
        if (raw.type !== "stream_event" && !this.quieted) {
          for (const f of this.listeners) { try { f(e.driver, ev); } catch (err) { console.error(`session ${e.driver.id}: event listener failed:`, err); } }
        }
      }
    } catch (err) {
      console.error(`session ${e.driver.id}: driver events failed:`, err);
    }
    // Driver が終わった。購読を閉じ、末尾だけ残し、状態の変化を知らせる。台帳の項目はしばらく残す（exited として見える）。消すのは sweep
    if (this.entries.get(e.driver.id) !== e) return;
    e.ended = true;
    e.endedAt = this.now();
    this.idle?.forget(e.driver.id);
    for (const s of e.subs) s.close();
    e.subs.clear();
    if (e.events.length > KEEP_AFTER_EXIT) e.events.splice(0, e.events.length - KEEP_AFTER_EXIT);
    const st = e.driver.summary().state;
    if (st !== e.lastState) { e.lastState = st; this.emitChange(e.driver); }
  }
}
