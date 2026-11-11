// メモリの台帳。Driver を登録し、イベントに seq を振ってため、SSE 用の購読を出す。ファイルには何も書かない
import type { Driver, DriverEvent } from "../engine/driver";
import type { SessionSummary } from "./types";
import { AsyncQueue } from "./async-queue";

const DEFAULT_MAX_EVENTS = 2000;
const KEEP_AFTER_EXIT = 50; // 終了後に残す末尾の件数。遅れて繋いだ購読者が終わりの理由を読めるように
const DEFAULT_ENDED_TTL_MS = 30 * 60_000; // 終わったセッションを台帳に残す時間。過ぎたら消す（過去の会話は履歴から読める）
const DEFAULT_MAX_ENDED = 100;            // 終わったセッションを残す件数の上限。超えたら古いものから消す
const DEFAULT_UNSENT_TTL_MS = 30 * 60_000; // プロンプト無しで立てて1通も届かないセッションを残す時間。終わったものと同じ30分
type Change = { id: string; summary: SessionSummary };
type Entry = {
  driver: Driver;
  events: DriverEvent[];
  seq: number;        // この id で最後に振った番号。同じ id を入れ直しても引き継ぐ
  trimmedTo: number;  // 上限超えで捨てた最後の seq。これ以前のカーソルは欠落がある
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

  constructor(opts: { maxEvents?: number; endedTtlMs?: number; maxEnded?: number; unsentTtlMs?: number; now?: () => number } = {}) {
    this.maxEvents = opts.maxEvents ?? DEFAULT_MAX_EVENTS;
    this.endedTtlMs = opts.endedTtlMs ?? DEFAULT_ENDED_TTL_MS;
    this.unsentTtlMs = opts.unsentTtlMs ?? DEFAULT_UNSENT_TTL_MS;
    this.maxEnded = opts.maxEnded ?? DEFAULT_MAX_ENDED;
    this.now = opts.now ?? Date.now;
  }

  add(d: Driver) {
    this.sweep();
    const old = this.entries.get(d.id);
    if (old) { for (const s of old.subs) s.close(); old.subs.clear(); }
    const e: Entry = { driver: d, events: [], seq: old?.seq ?? 0, trimmedTo: old?.trimmedTo ?? 0, ended: false, subs: new Set(), lastState: d.summary().state };
    this.entries.set(d.id, e);
    this.emitChange(d);
    void this.pump(e);
  }
  get(id: string): Driver | undefined { return this.entries.get(id)?.driver; }
  list(): SessionSummary[] { this.sweep(); return [...this.entries.values()].map((e) => e.driver.summary()); }
  // この id で最後に振った seq（stream_event を含む）。送る前の末尾として CLI に返す
  lastSeq(id: string): number | undefined { return this.entries.get(id)?.seq; }
  remove(id: string) {
    const e = this.entries.get(id);
    if (!e) return;
    this.entries.delete(id);
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
      if (t - (e.endedAt ?? t) >= this.endedTtlMs || ended.length - i > this.maxEnded) this.entries.delete(id);
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
        if (st !== e.lastState) { e.lastState = st; this.emitChange(e.driver); }
      }
    } catch (err) {
      console.error(`session ${e.driver.id}: driver events failed:`, err);
    }
    // Driver が終わった。購読を閉じ、末尾だけ残し、状態の変化を知らせる。台帳の項目はしばらく残す（exited として見える）。消すのは sweep
    if (this.entries.get(e.driver.id) !== e) return;
    e.ended = true;
    e.endedAt = this.now();
    for (const s of e.subs) s.close();
    e.subs.clear();
    if (e.events.length > KEEP_AFTER_EXIT) e.events.splice(0, e.events.length - KEEP_AFTER_EXIT);
    const st = e.driver.summary().state;
    if (st !== e.lastState) { e.lastState = st; this.emitChange(e.driver); }
  }
}
