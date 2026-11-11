// 対象の解決。<peer>/<sessionId の先頭8文字以上> か sessionId を、一覧から1つに絞る
import type { SessionSummary } from "../sessions/types";
import { CliError } from "./client";
import { CLI_NAME } from "../names";

export function parseTarget(t: string): { peer?: string; id: string } {
  const i = t.indexOf("/");
  return i > 0 ? { peer: t.slice(0, i), id: t.slice(i + 1) } : { id: t };
}

export function matchSession(list: SessionSummary[], id: string): SessionSummary {
  if (id.length < 8) throw new CliError(1, `「${id}」は短すぎる。sessionId の先頭8文字以上で指定する`);
  const exact = list.find((s) => s.id === id);
  if (exact) return exact;
  const hits = list.filter((s) => s.id.startsWith(id));
  if (hits.length === 1) return hits[0]!;
  if (hits.length === 0) throw new CliError(1, `「${id}」に当たるセッションが無い。${CLI_NAME} ls で確かめる`);
  throw new CliError(1, `「${id}」は複数ある:\n${hits.map((s) => `  ${s.id}  ${s.kind}  ${s.cwd}`).join("\n")}`);
}
