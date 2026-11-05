// SDK から過去のセッションと会話を読む。jsonl を直接は読まない。親（子認識）は firstPrompt の from 行から導く
import type { listSessions, getSessionMessages, SessionMessage } from "@anthropic-ai/claude-agent-sdk";
import type { SessionSummary } from "../sessions/types";
import { parseFromLine } from "../identity/from-line";

export type HistoryFns = { listSessions: typeof listSessions; getSessionMessages: typeof getSessionMessages };
const PAGE = 200;
const NONE = { send: false, permissions: false, interrupt: false };

export class History {
  constructor(private fns: HistoryFns) {}
  async list(limit = 100): Promise<SessionSummary[]> {
    const infos = await this.fns.listSessions({ limit });
    return infos.map((i) => ({
      id: i.sessionId,
      kind: "node" as const,
      capabilities: NONE,
      cwd: (i as { cwd?: string }).cwd ?? "",
      state: "exited" as const,
      startedAt: i.lastModified,
      lastActivityAt: i.lastModified,
      title: i.customTitle ?? i.summary,
      parent: i.firstPrompt ? parseFromLine(i.firstPrompt)?.id : undefined,
    }));
  }
  async messages(id: string, after = 0): Promise<{ messages: SessionMessage[]; next?: number }> {
    const messages = await this.fns.getSessionMessages(id, { offset: after, limit: PAGE });
    return { messages, next: messages.length ? after + messages.length : undefined };
  }
}
