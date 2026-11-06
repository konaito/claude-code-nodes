// ~/.claude/settings.json に crossSessionInbound: accept を併合する。受信側が bypass のとき、ソケットからの文が保留されないようにする（仕様 1.1）
export class SettingsError extends Error { constructor(msg: string) { super(msg); this.name = "SettingsError"; } }

export function withCrossSessionInbound(text: string): string {
  if (!text.trim()) throw new SettingsError("settings.json が空なので書かない（読み出しに失敗した可能性がある）");
  let v: unknown;
  try { v = JSON.parse(text); } catch { throw new SettingsError("settings.json が JSON として読めないので書かない"); }
  if (!v || typeof v !== "object" || Array.isArray(v)) throw new SettingsError("settings.json がオブジェクトではないので書かない");
  const obj = v as Record<string, unknown>;
  obj.crossSessionInbound = "accept";
  return JSON.stringify(obj, null, 2) + "\n";
}
