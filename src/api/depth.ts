// セッションの深さ。人が立てたもの（親が email、local、無し）が0、その子が1、孫が2。孫は子を作れない。
// 生きているセッションは作ったときに刻んだ値を使う。刻んだ値が無いもの（端末、過去、再起動の前に作ったもの）は、
// 親（生きている間の呼び手と、最初の文の from 行の呼び手）をたどり、大きいほうを取る。
// 受け口（lobby）は行き先を選んで子を立てるだけなので、受け口の子は受け口と同じ深さにする（段に数えない）
import { parseAgent } from "../identity/agent-name";
import type { SessionSummary } from "../sessions/types";

export const MAX_DEPTH = 2;
export const DEPTH_REFUSAL = "孫（深さ2）は子を作れない。仕事は自分でやるか、sub-agent（Agent ツール）を使う";
export const DEPTH_HINT = "子を作れるのは深さ1まで（人が立てたセッションが0、その子が1、孫が2）";
export const DEPTH_HOPS = 6; // たどる段数の上限。受け口は深さを増やさないので、深さの上限より少し多く取る

// known: 親を全部たどれた（false なら depth は下限）。callerDepth は人の呼び手で -1
export type SessionDepth = { id: string; depth: number; lobby: boolean; known: boolean };
export type ChildDepth = { callerDepth: number; depth: number; known: boolean };
type Target = Pick<SessionSummary, "id" | "cwd" | "parent">;

export type DepthSources = {
  nodeName: string;
  stamped: (id: string) => number | undefined;                 // 作ったときに刻んだ深さ（生きているものだけ）
  find: (sid: string) => Promise<Target[]>;                     // sessionId か先頭8文字で当たるセッション（生きている、端末、過去）
  firstParent: (id: string) => Promise<string | undefined>;     // 最初の文の from 行の呼び手
  isLobby: (cwd: string) => Promise<boolean>;
  remote: (peer: string, sid: string, hops: number) => Promise<SessionDepth | undefined>; // 別のノードに聞く。分からなければ undefined
};

export class DepthTracer {
  constructor(private s: DepthSources) {}

  // 呼び手（from 行の名前）が子を立てたら、その子は深さいくつになるか
  async childOf(callerId: string | undefined, hops = DEPTH_HOPS): Promise<ChildDepth> {
    const a = callerId ? parseAgent(callerId) : undefined;
    // 人（email、local）と sessionId を名乗らない呼び手は、人として扱う。ノードからは見分けられない
    if (!a?.sid) return { callerDepth: -1, depth: 0, known: true };
    let at: SessionDepth | undefined;
    if (hops > 0) {
      at = a.node === this.s.nodeName
        ? await this.session(a.sid, hops - 1)
        : await this.s.remote(a.node, a.sid, hops - 1).catch(() => undefined);
    }
    // 呼び手のセッションが見つからない。sessionId を名乗るのは Claude のセッションなので、子は少なくとも深さ1（受け口なら0）
    if (!at) return { callerDepth: 0, depth: a.role === "lobby" ? 0 : 1, known: false };
    return { callerDepth: at.depth, depth: at.depth + (at.lobby ? 0 : 1), known: at.known };
  }

  // このノードのセッションの深さ。複数に当たったら大きいほう。見つからなければ undefined
  async session(sid: string, hops = DEPTH_HOPS): Promise<SessionDepth | undefined> {
    let best: SessionDepth | undefined;
    for (const t of await this.s.find(sid)) {
      const d = await this.of(t, hops);
      if (!best || d.depth > best.depth) best = { ...d, known: d.known && best?.known !== false };
    }
    return best;
  }

  // 1つのセッションの深さ。刻んだ値があればそれ、無ければ親をたどる
  async of(t: Target, hops = DEPTH_HOPS): Promise<SessionDepth> {
    const lobby = await this.s.isLobby(t.cwd);
    const stamped = this.s.stamped(t.id);
    if (stamped !== undefined) return { id: t.id, depth: stamped, lobby, known: true };
    const first = await this.s.firstParent(t.id).catch(() => undefined);
    let depth = 0, known = true;
    for (const p of new Set([t.parent, first].filter((x): x is string => !!x))) {
      const c = await this.childOf(p, hops);
      depth = Math.max(depth, c.depth);
      known &&= c.known;
    }
    return { id: t.id, depth, lobby, known };
  }
}
