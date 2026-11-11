// 引数の分解。--k v、--k=v、--flag を flags に、残りを words に入れる。値を取らない旗は BOOLS
export type Parsed = { words: string[]; flags: Record<string, string | true> };
const BOOLS = new Set(["mine", "help", "fork", "yes", "cf-token-stdin", "json"]);

export function parseArgs(argv: string[]): Parsed {
  const words: string[] = [];
  const flags: Record<string, string | true> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--") { words.push(...argv.slice(i + 1)); break; }
    if (!a.startsWith("--")) { words.push(a); continue; }
    const eq = a.indexOf("=");
    if (eq > 0) { flags[a.slice(2, eq)] = a.slice(eq + 1); continue; }
    const k = a.slice(2);
    const next = argv[i + 1];
    if (BOOLS.has(k) || next === undefined || next.startsWith("--")) flags[k] = true;
    else { flags[k] = next; i++; }
  }
  return { words, flags };
}
