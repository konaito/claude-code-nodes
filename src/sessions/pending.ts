// 承認待ち（PendingPermission と permission_request の data）を1行で見せる。CLI の show と read、MCP の get_session と read_messages が同じ文を出す。
// 承認する側（受け口や人）が中身で判断できるように、Bash は command、ファイルの道具は file_path、ほかは入力の主な値を出す。
// 値は子が書いた文字列なので、改行や制御文字は JSON の書き方で逃がし（偽の行を作らせない）、長ければ切って「…(+N字)」を付ける。
// description も子が書いた説明なので、中身の後ろに補足として付ける
export const PENDING_VALUE_MAX = 400;

type PendingLike = { toolName?: unknown; input?: unknown; description?: unknown; [k: string]: unknown };

// 道具ごとに見せる入力の鍵。先頭から、値が文字列のものを出す
const KEYS: Record<string, string[]> = {
  Bash: ["command"],
  Write: ["file_path"],
  Edit: ["file_path"],
  MultiEdit: ["file_path"],
  Read: ["file_path"],
  NotebookEdit: ["notebook_path"],
  Glob: ["pattern", "path"],
  Grep: ["pattern", "path", "glob"],
  WebFetch: ["url"],
  WebSearch: ["query"],
};
// 表に無い道具（MCP など）で探す鍵
const FALLBACK = ["command", "file_path", "path", "url", "query", "pattern", "skill", "prompt"];

export function clip(v: string, max = PENDING_VALUE_MAX): string {
  const chars = [...v];
  return chars.length > max ? `${chars.slice(0, max).join("")}…(+${chars.length - max}字)` : v;
}
// JSON の文字列の書き方にする（改行は \n、引用符は \"）。切るのは逃がした後の文字数で数える
const quote = (v: string, max = PENDING_VALUE_MAX) => clip(JSON.stringify(v), max);

// 入力の文字列の値を切った写し（MCP の get_session が JSON で返す分。Write の content を丸ごと出さない）
export function clipInput(input: unknown, max = 2000): unknown {
  if (!input || typeof input !== "object" || Array.isArray(input)) return input;
  return Object.fromEntries(Object.entries(input as Record<string, unknown>).map(([k, v]) => [k, typeof v === "string" ? clip(v, max) : v]));
}

// 例: Bash command="git push origin main" (Push to remote)
//     Write file_path="/x/y.txt"
//     Bash (中身なし) … input が無い（古い版のノード、試験の偽物）
export function describePending(p: PendingLike, max = PENDING_VALUE_MAX): string {
  const tool = typeof p.toolName === "string" ? p.toolName : "?";
  const input = p.input && typeof p.input === "object" && !Array.isArray(p.input) ? (p.input as Record<string, unknown>) : undefined;
  const parts: string[] = [tool];
  let shownValues: unknown[] = [];
  if (!input) parts.push("(中身なし)");
  else {
    const keys = KEYS[tool] ?? FALLBACK;
    const shown = keys.filter((k) => typeof input[k] === "string").map((k) => `${k}=${quote(input[k] as string, max)}`);
    shownValues = keys.map((k) => input[k]);
    if (shown.length) parts.push(...shown);
    else {
      // 主な値が分からない道具は、入力をそのまま JSON で出す（description は下で付ける）
      const { description: _, ...rest } = input;
      parts.push(Object.keys(rest).length ? `input=${clip(JSON.stringify(rest), max)}` : "(中身なし)");
    }
  }
  // node-driver は description が無いと file_path を入れるので、上に出した値と同じなら重ねない
  if (typeof p.description === "string" && p.description && !shownValues.includes(p.description)) parts.push(`(${quote(p.description, 120)})`);
  return parts.join(" ");
}
