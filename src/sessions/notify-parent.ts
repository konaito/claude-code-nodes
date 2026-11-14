// エージェントが立てた子のターンの終わり、承認待ち、思わぬ終わり方を、親のセッションへ短い文で知らせる。
// 親は read_messages を自分から呼ばないと子の報告に気づかなかった（2026-11-14、ct-order-drop の報告に親が14分気づかなかった）。
// 台帳（SessionStore.onEvent）から result、permission_request、exited を受け、子ごとに後ろ寄せでまとめてから送る。
// 送る先の解決（同じノードの生きた親、輪にならないか）は呼び手（api/sessions.ts）が resolveParent で決める。
// 知らせは子から親への一方向だけで、親のターンの終わりは子に送らない（親が子の子でない限り。輪は resolveParent が断る）
import { basename } from "node:path";
import type { Driver, DriverEvent } from "../engine/driver";
import { BusyError } from "../engine/driver";
import type { PendingPermission, SessionSummary } from "./types";
import { IDLE_STOP_PREFIX } from "./idle-stop";

// 知らせの from 行の呼び手の頭。agent: で始めない（child.md は from agent: の文を親の依頼として扱う）
export const NOTIFY_FROM_PREFIX = "ccn:";
export const NOTIFY_TAG = "[ccn]";
const DESC_MAX = 120; // 承認の説明（子が決められる文字列）を1行に潰して切る長さ
const REASON_MAX = 200;

export type NotifyTiming = {
  delayMs?: number;  // 最初のイベントから送るまで待つ時間。続けて来たイベントをまとめる。既定 3秒
  minGapMs?: number; // 同じ子から続けて送る間隔の下限（終わったときの知らせは除く）。既定 20秒
  retryMs?: number;  // 親が受けられないとき（pty の承認待ち）に送り直す間隔。既定 10秒
  retries?: number;  // 送り直す回数の上限。既定 6
};
export type NotifyDeps = NotifyTiming & {
  nodeName: string;
  resolveParent: (child: SessionSummary) => Promise<Driver | undefined>;
  historyBase: (id: string) => number; // 子の台帳の番号の始まり（resume した pty は履歴の件数）。最初のターンの cursor
  now?: () => number;
};

type Pending = {
  child: Driver;
  turns: number;
  turnSeq?: number;     // 最後の result の seq
  turnError?: boolean;
  exited?: string;      // 終わった理由
  timer?: ReturnType<typeof setTimeout>;
  tries: number;
};

const oneLine = (s: string, max: number) => { const t = s.replace(/\s+/g, " ").trim(); return t.length > max ? `${t.slice(0, max)}…` : t; };
export const childLabel = (s: SessionSummary) => oneLine(s.title || basename(s.cwd) || s.id.slice(0, 8), 60);

export class ParentNotifier {
  private pending = new Map<string, Pending>();
  private lastSent = new Map<string, number>(); // 子ごとに最後に送った時刻
  private turnFrom = new Map<string, number>(); // 子ごとに、次のターンの知らせで渡す cursor（前に知らせた result の seq）
  private suppressed = new Set<string>();       // API で止めた子。exited を知らせない
  private now: () => number;
  private delayMs: number;
  private minGapMs: number;
  private retryMs: number;
  private retries: number;

  constructor(private d: NotifyDeps) {
    this.now = d.now ?? Date.now;
    this.delayMs = d.delayMs ?? 3000;
    this.minGapMs = d.minGapMs ?? 20_000;
    this.retryMs = d.retryMs ?? 10_000;
    this.retries = d.retries ?? 6;
  }

  // 親（や人）が API で止める直前に呼ぶ。その子の exited は知らせない
  suppress(id: string) {
    this.suppressed.add(id);
    if (this.suppressed.size > 256) this.suppressed.delete(this.suppressed.values().next().value!); // 終わりが来なかった分を溜めない
  }

  // 台帳のイベントを1件受ける
  observe(child: Driver, ev: DriverEvent) {
    const s = child.summary();
    // 知らせる相手がいるのはエージェントが立てた子だけ。細かい判定（同じノードか、生きているか）は送るときに resolveParent がする
    if (!s.parent?.startsWith("agent:")) return;
    if (ev.type === "result") {
      const data = (ev.data ?? {}) as { subtype?: string; is_error?: boolean };
      // 中断（interrupt_session か端末の Esc）は止めた側が知っている
      if (data.subtype === "interrupted") return;
      const p = this.slot(child);
      p.turns++;
      p.turnSeq = ev.seq;
      p.turnError ||= data.is_error === true;
      this.schedule(child.id, p);
    } else if (ev.type === "permission_request") {
      this.schedule(child.id, this.slot(child));
    } else if (ev.type === "exited") {
      const reason = String((ev.data as { reason?: unknown } | undefined)?.reason ?? s.exitReason ?? "");
      const stopped = this.suppressed.delete(child.id);
      if (stopped || reason.startsWith(IDLE_STOP_PREFIX)) { this.forget(child.id); return; }
      const p = this.slot(child);
      p.exited = reason || "ended";
      this.schedule(child.id, p, true);
    }
  }

  get size() { return this.pending.size; }

  private slot(child: Driver): Pending {
    let p = this.pending.get(child.id);
    if (!p || p.child !== child) { if (p?.timer) clearTimeout(p.timer); p = { child, turns: 0, tries: 0 }; this.pending.set(child.id, p); }
    return p;
  }
  private forget(id: string) {
    const p = this.pending.get(id);
    if (p?.timer) clearTimeout(p.timer);
    this.pending.delete(id);
    this.lastSent.delete(id);
    this.turnFrom.delete(id);
  }
  // 後ろ寄せでまとめる。待っている間に来たイベントは同じ1通に入る。終わったときは間隔の下限を待たない
  private schedule(id: string, p: Pending, urgent = false, ms?: number) {
    const gap = urgent ? 0 : (this.lastSent.get(id) ?? -Infinity) + this.minGapMs - this.now();
    const wait = ms ?? Math.max(this.delayMs, gap);
    if (p.timer) {
      if (!urgent && ms === undefined) return; // もう待っている
      clearTimeout(p.timer);
    }
    p.timer = setTimeout(() => { p.timer = undefined; void this.flush(id, p).catch((e) => console.error(`session ${id}: notify parent failed:`, e)); }, wait);
    (p.timer as { unref?: () => void }).unref?.();
  }

  // 送り始めたら台帳の枠から外す。送っている間に来たイベントは新しい枠に入り、別の1通になる
  private async flush(id: string, p: Pending) {
    if (this.pending.get(id) !== p) return;
    this.pending.delete(id);
    const s = p.child.summary();
    const msg = this.compose(s, p);
    const done = () => { if (p.exited) this.forget(id); };
    if (!msg) return done();
    const parent = await this.d.resolveParent(s).catch(() => undefined);
    const ps = parent?.summary();
    // 親が見つからない、終わっている、1通目を待っている（送ると claude が起動し、知らせが最初の文になる）なら送らない
    if (!parent || !ps || ps.state === "exited" || ps.awaitingFirst || !parent.capabilities.send) return done();
    try {
      await parent.send(`from ${NOTIFY_FROM_PREFIX}${this.d.nodeName}/${s.id.slice(0, 8)} via ${this.d.nodeName}\n\n${msg.text}`);
    } catch (e) {
      // pty の親が承認待ちの間は受けられない。少し待って、そのときの状態で作り直して送る
      if (e instanceof BusyError && ++p.tries <= this.retries) return this.retry(id, p);
      console.error(`session ${id}: notify parent ${ps.id} failed:`, e instanceof Error ? e.message : e);
      return done();
    }
    this.lastSent.set(id, this.now());
    if (msg.turn && p.turnSeq !== undefined) this.turnFrom.set(id, Math.max(p.turnSeq, this.turnFrom.get(id) ?? 0));
    done();
  }
  // 送り直す。その間に新しい枠ができていれば、そちらにまとめる
  private retry(id: string, p: Pending) {
    const cur = this.pending.get(id);
    if (cur && cur.child === p.child) {
      cur.turns += p.turns;
      cur.turnSeq ??= p.turnSeq;
      cur.turnError ||= !!p.turnError;
      cur.exited ??= p.exited;
      cur.tries = Math.max(cur.tries, p.tries);
      return;
    }
    if (cur) return;
    this.pending.set(id, p);
    this.schedule(id, p, false, this.retryMs);
  }

  // 送るときの状態で文を作る。もう当たらないもの（作業に戻ったターン、答え済みの承認）は入れない。何も無ければ undefined
  private compose(s: SessionSummary, p: Pending): { text: string; turn?: boolean } | undefined {
    const who = `子 ${childLabel(s)}（${s.id.slice(0, 8)}）`;
    const node = this.d.nodeName;
    if (p.exited) return { text: `${NOTIFY_TAG} ${who}が終わった: ${oneLine(p.exited, REASON_MAX)}。会話は create_session peer=${node} resume=${s.id} で続けられる` };
    const perms = p.child.pending();
    if (perms.length) {
      const q = perms[0]!;
      const more = perms.length > 1 ? `（ほか${perms.length - 1}件）` : "";
      return { text: `${NOTIFY_TAG} ${who}が承認を待っている: ${describe(q)}${more}。answer_permission peer=${node} session=${s.id} request_id=${q.requestId} で答えて` };
    }
    if (p.turns && s.state === "idle") {
      const after = this.turnFrom.get(s.id) ?? this.d.historyBase(s.id);
      const n = p.turns > 1 ? `（${p.turns}回分）` : "";
      return { turn: true, text: `${NOTIFY_TAG} ${who}のターンが${p.turnError ? "エラーで" : ""}終わった${n}。read_messages peer=${node} session=${s.id} after=${after} で読んで（読み済みなら返事は不要）` };
    }
    return undefined;
  }
}

function describe(q: PendingPermission): string {
  const input = q.input ?? {};
  const detail = q.description ?? (typeof input.command === "string" ? input.command : typeof input.url === "string" ? input.url : "");
  return oneLine(detail ? `${q.toolName} ${detail}` : q.toolName, DESC_MAX);
}
