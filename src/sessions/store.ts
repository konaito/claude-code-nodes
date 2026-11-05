// メモリの台帳。Driver を登録し、イベントに seq を振ってため、SSE 用の購読を出す。ファイルには何も書かない
import type { Driver, DriverEvent } from "../engine/driver";
import type { SessionSummary } from "./types";
import { AsyncQueue } from "./async-queue";

const MAX_EVENTS = 2000;
type Change = { id: string; summary: SessionSummary };
type Entry = { driver: Driver; events: DriverEvent[]; seq: number; subs: Set<AsyncQueue<DriverEvent>>; lastState: string };

export class SessionStore {
  private entries = new Map<string, Entry>();
  private allSubs = new Set<AsyncQueue<Change>>();

  add(d: Driver) {
    const e: Entry = { driver: d, events: [], seq: 0, subs: new Set(), lastState: d.summary().state };
    this.entries.set(d.id, e);
    this.emitChange(d);
    void this.pump(e);
  }
  get(id: string): Driver | undefined { return this.entries.get(id)?.driver; }
  list(): SessionSummary[] { return [...this.entries.values()].map((e) => e.driver.summary()); }
  remove(id: string) {
    const e = this.entries.get(id);
    if (!e) return;
    this.entries.delete(id);
    for (const s of e.subs) s.close();
    e.subs.clear();
    this.emitChange(e.driver);
  }
  eventsSince(id: string, after: number): DriverEvent[] {
    const e = this.must(id);
    return e.events.filter((ev) => ev.seq > after);
  }
  subscribe(id: string, after: number): AsyncIterable<DriverEvent> {
    const e = this.must(id);
    const q = new AsyncQueue<DriverEvent>();
    for (const ev of this.eventsSince(id, after)) q.push(ev);
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
  private emitChange(d: Driver) {
    const c = { id: d.id, summary: d.summary() };
    for (const s of this.allSubs) s.push(c);
  }
  private async pump(e: Entry) {
    for await (const raw of e.driver.events()) {
      if (this.entries.get(e.driver.id) !== e) break;
      e.seq++;
      const ev: DriverEvent = { ...raw, seq: e.seq };
      e.events.push(ev);
      if (e.events.length > MAX_EVENTS) e.events.shift();
      for (const s of e.subs) s.push(ev);
      const st = e.driver.summary().state;
      if (st !== e.lastState) { e.lastState = st; this.emitChange(e.driver); }
    }
    // Driver が終わった。生きている購読は閉じ、状態の変化を知らせる。台帳の項目は残す（exited として見える）
    if (this.entries.get(e.driver.id) === e) {
      for (const s of e.subs) s.close();
      e.subs.clear();
      const st = e.driver.summary().state;
      if (st !== e.lastState) { e.lastState = st; this.emitChange(e.driver); }
    }
  }
}
