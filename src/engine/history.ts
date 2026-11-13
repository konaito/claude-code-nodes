// SDK から過去のセッションと会話を読む。jsonl を直接は読まない。親（子認識）は firstPrompt の from 行から導く
import type { listSessions, getSessionMessages, getSessionInfo, SDKSessionInfo, SessionMessage } from "@anthropic-ai/claude-agent-sdk";
import type { SessionSummary } from "../sessions/types";
import { parseFirstPrompt } from "../identity/from-line";

export type HistoryFns = { listSessions: typeof listSessions; getSessionMessages: typeof getSessionMessages; getSessionInfo: typeof getSessionInfo };
export const PAGE = 200;
const NONE = { send: false, permissions: false, interrupt: false, stop: false, events: false };

// 会話の件数を覚える数の上限。Claude Town などが開いている会話の数より十分多ければよい
const MARKS_MAX = 256;
type Mark = { key: string; count: number };

export class History {
  // 会話の件数と、そのときの jsonl の印（getSessionInfo の lastModified と fileSize）。解析した会話そのものは持たない
  private marks = new Map<string, Mark>();
  // セッションの jsonl の置き場の手がかり（getSessionInfo の cwd）。dir を渡すと全部のプロジェクトを探さずに済む
  private dirs = new Map<string, string>();
  constructor(private fns: HistoryFns) {}
  async list(limit = 100): Promise<SessionSummary[]> {
    const infos = await this.fns.listSessions({ limit });
    return infos.map(toSummary);
  }
  // 一覧の上限に関係なく 1 件を引く
  async get(id: string): Promise<SessionSummary | undefined> {
    const { info } = await this.info(id);
    return info ? toSummary(info) : undefined;
  }
  // 会話を after の次から1ページ（最大 limit 件、既定 200）読む。jsonl の印が前に数えたときと同じで、after がその件数以上なら、読まずに空を返す
  async messages(id: string, after = 0, limit = PAGE): Promise<{ messages: SessionMessage[]; next?: number }> {
    const { key, dir } = await this.info(id);
    const m = key ? this.marks.get(id) : undefined;
    if (m && m.key === key && after >= m.count) return { messages: [], next: undefined };
    const messages = await this.fns.getSessionMessages(id, { ...dir, offset: after, limit });
    // 1ページに収まったなら、そこが末尾なので件数が分かる
    if (key && messages.length < limit && (messages.length > 0 || after === 0)) this.remember(id, { key, count: after + messages.length });
    return { messages, next: messages.length ? after + messages.length : undefined };
  }
  // 会話の件数。messages の after（offset）で数えた末尾。jsonl の印が変わっていなければ数え直さない
  async count(id: string): Promise<number> {
    const { key, dir } = await this.info(id);
    const m = key ? this.marks.get(id) : undefined;
    if (m && m.key === key) return m.count;
    const count = (await this.fns.getSessionMessages(id, dir)).length;
    if (key) this.remember(id, { key, count });
    return count;
  }
  // jsonl の印を先に取り、そのあとで読む。読む間に jsonl が伸びても、次の呼び出しで印が変わるので数え直す。
  // 前に分かった cwd を dir に渡し、見つからなければ（途中で cwd が変わったときなど）dir なしで探し直す
  private async info(id: string): Promise<{ info?: SDKSessionInfo; key?: string; dir?: { dir: string } }> {
    const hint = this.dirs.get(id);
    let info = hint ? await this.fns.getSessionInfo(id, { dir: hint }) : undefined;
    let dir = info && hint ? { dir: hint } : undefined;
    if (!info) {
      info = await this.fns.getSessionInfo(id);
      const cwd = (info as { cwd?: string } | undefined)?.cwd;
      if (cwd) { bounded(this.dirs, id, cwd); dir = undefined; }
      else this.dirs.delete(id);
    }
    const key = info && typeof info.fileSize === "number" ? `${info.lastModified}:${info.fileSize}` : undefined;
    return { info, key, dir };
  }
  private remember(id: string, m: Mark) { bounded(this.marks, id, m); }
}

// 入れた順に古いものから捨てる。同じキーは入れ直して新しくする
function bounded<V>(map: Map<string, V>, k: string, v: V) {
  map.delete(k);
  map.set(k, v);
  if (map.size > MARKS_MAX) map.delete(map.keys().next().value!);
}

function toSummary(i: SDKSessionInfo): SessionSummary {
  return {
    id: i.sessionId,
    kind: "node",
    capabilities: NONE,
    cwd: (i as { cwd?: string }).cwd ?? "",
    state: "exited",
    startedAt: i.lastModified,
    lastActivityAt: i.lastModified,
    title: i.customTitle ?? i.summary,
    parent: i.firstPrompt ? parseFirstPrompt(i.firstPrompt)?.id : undefined,
  };
}
