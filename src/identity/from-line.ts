// 子の Claude に届く文の先頭に付ける from 行。子認識の親はこの行から導く
import type { Caller } from "./identity";

const RE = /^from (\S+) via (\S+)\s*$/m;

export function fromLine(c: Caller, nodeName: string): string {
  return `from ${c.id} via ${c.via ?? nodeName}`;
}
export function withFromLine(c: Caller, nodeName: string, text: string): string {
  return `${fromLine(c, nodeName)}\n\n${text}`;
}
// 先頭行が from 行なら { id, via }。違えば undefined
export function parseFromLine(text: string): Caller | undefined {
  const first = text.split("\n", 1)[0] ?? "";
  const m = RE.exec(first);
  return m ? { id: m[1]!, via: m[2]! } : undefined;
}
