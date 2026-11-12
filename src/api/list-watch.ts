// セッションの一覧の変化を流す（GET /api/sessions/stream、#24）。購読がある間だけ動き、無ければタイマーも台帳の購読も持たない。
// 変化の出どころは2つある。台帳（ノードが立てた子と PTY）の状態の変化はすぐ届く。端末のセッション（claude agents --json）と
// 終わったセッション（listSessions）は知らせが無いので、tickMs ごとに agents を取り直して一覧を比べる
import { AsyncQueue } from "../sessions/async-queue";
import type { SessionSummary, State } from "../sessions/types";
import type { Frame } from "./sse";

export type ListFilter = { parent: string | null; states: Set<State> | null };
export type ListWatchDeps = {
  list: (f: ListFilter) => Promise<SessionSummary[]>;
  refresh: () => Promise<void>;             // 端末のセッションを取り直す（claude agents --json を1回起動する）
  changes: () => AsyncIterable<unknown>;    // 台帳の変化
  tickMs?: number;
  debounceMs?: number;
};
// 端末のセッションを取り直す間隔。claude agents --json は1回 CPU 約0.27秒なので、Claude Town が一覧を2秒ごとに呼んで
// いたときの起動回数（約4秒に1回、2026-11-13 の実測）と同じにした
export const LIST_TICK_MS = 4000;
const DEBOUNCE_MS = 200;

export const etagOf = (body: string) => `"${Bun.hash(body).toString(16)}"`;
const keyOf = (f: ListFilter) => `${f.parent ?? ""}|${f.states ? [...f.states].sort().join(",") : ""}`;

type Sub = { q: AsyncQueue<Frame>; filter: ListFilter; last?: string };

export class ListWatch {
  private subs = new Set<Sub>();
  private timer?: ReturnType<typeof setTimeout>;
  private debounce?: ReturnType<typeof setTimeout>;
  private changeIt?: AsyncIterator<unknown>;
  private running = false;
  private again = false;
  private gen = 0; // tick の連鎖の世代。止めて始め直したとき、古い連鎖が続かないように
  constructor(private d: ListWatchDeps) {}

  get size() { return this.subs.size; }

  // 最初に今の一覧を1回流し、その後は変わったときだけ流す。lastId（Last-Event-ID）が今の ETag と同じなら最初の1回を省く
  subscribe(filter: ListFilter, lastId?: string): AsyncIterable<Frame> {
    const q = new AsyncQueue<Frame>();
    const sub: Sub = { q, filter, last: lastId || undefined };
    this.subs.add(sub);
    q.onClose = () => { this.subs.delete(sub); if (!this.subs.size) this.stop(); };
    if (this.subs.size === 1) this.start();
    void this.emit([sub]);
    return q;
  }

  private start() {
    const g = ++this.gen;
    const it = this.d.changes()[Symbol.asyncIterator]();
    this.changeIt = it;
    void (async () => {
      for (;;) {
        const r = await it.next();
        if (r.done || this.changeIt !== it) return;
        clearTimeout(this.debounce);
        this.debounce = setTimeout(() => void this.emit(), this.d.debounceMs ?? DEBOUNCE_MS);
      }
    })();
    this.schedule(g);
  }
  private stop() {
    this.gen++;
    clearTimeout(this.timer);
    clearTimeout(this.debounce);
    this.timer = this.debounce = undefined;
    void this.changeIt?.return?.();
    this.changeIt = undefined;
  }
  private schedule(g: number) {
    this.timer = setTimeout(async () => {
      if (g !== this.gen) return;
      await this.d.refresh().catch(() => {});
      if (g !== this.gen) return;
      await this.emit();
      if (g === this.gen) this.schedule(g);
    }, this.d.tickMs ?? LIST_TICK_MS);
  }

  // 購読ごとに一覧を作り、前に流したものと ETag が違えば流す。同じ絞り込みの購読は1回で済ませる。
  // 作っている間に呼ばれたら、終わってからもう1回だけ作る
  private async emit(only?: Sub[]) {
    if (!only) {
      if (this.running) { this.again = true; return; }
      this.running = true;
    }
    try {
      const targets = only ?? [...this.subs];
      const byKey = new Map<string, Promise<SessionSummary[]>>();
      for (const s of targets) {
        const k = keyOf(s.filter);
        if (!byKey.has(k)) byKey.set(k, this.d.list(s.filter));
        let body: string;
        try { body = JSON.stringify(await byKey.get(k)!); } catch { continue; } // 一覧が取れなければ流さず、次の機会を待つ
        const etag = etagOf(body);
        if (etag === s.last || s.q.isClosed) continue;
        s.last = etag;
        s.q.push({ id: etag, event: "sessions", raw: body });
      }
    } finally {
      if (!only) {
        this.running = false;
        if (this.again) { this.again = false; void this.emit(); }
      }
    }
  }
}
