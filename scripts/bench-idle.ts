// 待機中のノードの CPU を測る（#23）。試験用のノードを別の設定と別のポートで立て、呼び手なしと Claude Town と同じ呼び方を分けて測る。
// 使い方: bun run scripts/bench-idle.ts <設定ファイル> <port> <none|town> <秒> [セッションID] [--prof <dir>]
// - none: 何も呼ばない
// - town: 下の3つを同時に。list、messages、detail はそれぞれ1つだけ。stream は一覧を SSE に替えたもの
// - town: GET /api/sessions を2秒ごと、GET /api/sessions/<id>/messages?after=<next> を2.5秒ごと、GET /api/sessions/<id> を2秒ごと
//   （Claude Town の POLL_MS、CONV_POLL_MS、Approval の間隔と同じ）
// ノード自身の CPU 時間は ps の time、子プロセス（claude agents --json など）の起動回数は ps で数える
const argv = process.argv.slice(2);
const pi = argv.indexOf("--prof");
const profDir = pi >= 0 ? argv[pi + 1] : undefined;
if (pi >= 0) argv.splice(pi, 2);
const [cfgPath, portS, mode, secsS, sid] = argv;
const MODES = ["none", "town", "list", "messages", "detail", "stream"];
if (!cfgPath || !portS || !MODES.includes(mode ?? "") || !secsS) {
  console.error(`usage: bench-idle.ts <config> <port> <${MODES.join("|")}> <secs> [sessionId] [--prof <dir>]`);
  process.exit(2);
}
const port = Number(portS);
const secs = Number(secsS);
const base = `http://127.0.0.1:${port}`;
const appRoot = new URL("..", import.meta.url).pathname;

const env = { ...process.env, CCN_CONFIG: cfgPath };
delete (env as Record<string, string | undefined>).CLAUDE_CONFIG_DIR; // 本番の常駐と同じく ~/.claude を読む
const args = ["bun", ...(profDir ? ["--cpu-prof", `--cpu-prof-dir=${profDir}`, "--cpu-prof-md"] : []), "run", "src/cli/ccn.ts", "serve"];
const node = Bun.spawn(args, { cwd: appRoot, env, stdout: "ignore", stderr: "inherit" });

async function cpuSecs(pid: number): Promise<number> {
  const out = (await new Response(Bun.spawn(["ps", "-o", "time=", "-p", String(pid)]).stdout).text()).trim();
  const m = out.match(/^(?:(\d+):)?(\d+):(\d+(?:\.\d+)?)$/);
  if (!m) return NaN;
  return Number(m[1] ?? 0) * 3600 + Number(m[2]) * 60 + Number(m[3]);
}
async function children(pid: number): Promise<number[]> {
  const out = await new Response(Bun.spawn(["pgrep", "-P", String(pid)]).stdout).text();
  return out.split("\n").filter(Boolean).map(Number);
}

for (let i = 0; ; i++) {
  if (i > 100) { console.error("node did not start"); node.kill(); process.exit(1); }
  try { if ((await fetch(`${base}/api/host`)).ok) break; } catch { /* まだ */ }
  await Bun.sleep(100);
}

let next = 0;
const lat: Record<string, number[]> = { list: [], messages: [], detail: [] };
const failed: Record<string, number> = {};
async function call(kind: string, path: string) {
  const t = performance.now();
  try {
    const r = await fetch(base + path);
    const body = await r.text();
    if (!r.ok) throw new Error(String(r.status));
    lat[kind]!.push(performance.now() - t);
    return { status: r.status, body };
  } catch {
    failed[kind] = (failed[kind] ?? 0) + 1;
    return { status: 0, body: "" };
  }
}
// 最初の一覧（履歴の読み込み）を済ませてから測る
await call("list", "/api/sessions");
lat.list = [];
await Bun.sleep(3000);

const seenChildren = new Set<number>();
const timers: ReturnType<typeof setInterval>[] = [];
// stream: 一覧は GET /api/sessions/stream?state=live を1本つなぐだけにし、messages と detail は town と同じに呼ぶ（#24 の後の Claude Town）
const on = (k: string) => mode === "town" || mode === k || (mode === "stream" && k !== "list");
let streamEvents = 0;
const streamCtl = new AbortController();
if (mode === "stream") {
  void (async () => {
    try {
      const r = await fetch(`${base}/api/sessions/stream?state=live`, { signal: streamCtl.signal });
      const dec = new TextDecoder();
      for await (const c of r.body!) streamEvents += (dec.decode(c).match(/^event: sessions$/gm) ?? []).length;
    } catch { /* 止めたとき */ }
  })();
}
{
  if (on("list")) timers.push(setInterval(() => void call("list", "/api/sessions"), 2000));
  if (sid && on("messages")) {
    timers.push(setInterval(async () => {
      const r = await call("messages", `/api/sessions/${sid}/messages?after=${next}`);
      try { const j = JSON.parse(r.body) as { next?: number }; if (typeof j.next === "number" && j.next > next) next = j.next; } catch { /* 無視 */ }
    }, 2500));
  }
  if (sid && on("detail")) timers.push(setInterval(() => void call("detail", `/api/sessions/${sid}`), 2000));
}
const watch = setInterval(async () => { for (const c of await children(node.pid)) seenChildren.add(c); }, 50);

const c0 = await cpuSecs(node.pid);
const t0 = performance.now();
await Bun.sleep(secs * 1000);
const c1 = await cpuSecs(node.pid);
const wall = (performance.now() - t0) / 1000;
for (const t of timers) clearInterval(t);
streamCtl.abort();
clearInterval(watch);

const med = (a: number[]) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.floor(s.length / 2)]!.toFixed(1) : "-"; };
const max = (a: number[]) => (a.length ? Math.max(...a).toFixed(1) : "-");
console.log(JSON.stringify({
  mode, secs: Number(wall.toFixed(1)), cpuSecs: Number((c1 - c0).toFixed(2)), cpuPct: Number((((c1 - c0) / wall) * 100).toFixed(2)),
  childSpawnsSeen: seenChildren.size, failed, ...(mode === "stream" ? { streamEvents } : {}),
  calls: Object.fromEntries(Object.entries(lat).map(([k, v]) => [k, { n: v.length, medMs: med(v), maxMs: max(v) }])),
}));
node.kill("SIGTERM");
await node.exited;
