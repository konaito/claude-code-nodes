// エージェントの名前（呼び手の id のうち agent: で始まるもの）の組み立てと分解。形は agent:<ノード>/<自分の sessionId の先頭8文字>/<役割>。
// sessionId が分からないときは agent:<ノード>/<役割>。子の画面や from 行から親をたどるのに使う（仕様 2.4）
export const AGENT_PREFIX = "agent:";
const NAME_MAX = 64; // agent: を除いた長さの上限
const SID = /^[0-9a-f]{8}$/;

export type AgentName = { node: string; sid?: string; role: string };

// 役割の使えない文字は - にし、全体を NAME_MAX に収める。sessionId は先頭8文字が16進のときだけ使う
export function formatAgent(node: string, sessionId: string | undefined, role: string | undefined): string {
  const label = (role && role.trim() ? role : "parent").replace(/[^A-Za-z0-9._/-]/g, "-");
  const sid = sessionId && /^[0-9a-f]{8}/.test(sessionId) ? sessionId.slice(0, 8) : undefined;
  const head = sid ? `${node}/${sid}/` : `${node}/`;
  return AGENT_PREFIX + head + label.slice(0, Math.max(1, NAME_MAX - head.length));
}

// formatAgent の形でなければ undefined（email、local、agent:<サービストークンの common_name> など）
export function parseAgent(id: string): AgentName | undefined {
  if (!id.startsWith(AGENT_PREFIX)) return undefined;
  const body = id.slice(AGENT_PREFIX.length);
  const i = body.indexOf("/");
  if (i <= 0 || i === body.length - 1) return undefined;
  const node = body.slice(0, i);
  const rest = body.slice(i + 1);
  const j = rest.indexOf("/");
  if (j > 0 && SID.test(rest.slice(0, j)) && j < rest.length - 1) return { node, sid: rest.slice(0, j), role: rest.slice(j + 1) };
  return { node, role: rest };
}

// 同じ親（ノードと sessionId が同じ）が名乗った名前か。役割は問わない。--mine の絞り込みに使う
export function sameParent(id: string | undefined, node: string, sessionId: string | undefined): boolean {
  if (!id) return false;
  const a = parseAgent(id);
  if (!a) return false;
  const sid = sessionId && /^[0-9a-f]{8}/.test(sessionId) ? sessionId.slice(0, 8) : undefined;
  return a.node === node && a.sid === sid;
}
