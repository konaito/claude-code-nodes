// `claude agents --json` の一覧（公式）と、端末セッションの受信ソケットの場所の候補
export type AgentInfo = {
  pid?: number;
  cwd: string;
  kind: "interactive" | "background";
  startedAt: number;
  sessionId?: string;
  name?: string;
  status?: "busy" | "waiting" | "idle";
  waitingFor?: string;
};
export type Runner = (cmd: string[]) => Promise<{ stdout: string; code: number }>;

export async function listAgents(run: Runner): Promise<AgentInfo[]> {
  const r = await run(["claude", "agents", "--json"]);
  if (r.code !== 0) return [];
  try {
    const v = JSON.parse(r.stdout);
    return Array.isArray(v) ? (v as AgentInfo[]) : [];
  } catch {
    return [];
  }
}

// 裏方の `claude -p`（Stop hook、launchd のジョブ）を除く。`claude agents --json` は `-p` の実行も kind interactive で返すので、
// pid ごとの制御端末と引数を ps で1回にまとめて読み、制御端末が無く、引数に `-p` か `--print` があるものを外す。
// 引数だけでは決めない。最初の文を引数で受けた対話のセッション（ccn の PTY の子など）は、文の中の `-p` に当たるため。
// pid が無い行、ps に出てこない行、ps が失敗したときは残す
export async function withoutHeadless(list: AgentInfo[], run: Runner): Promise<AgentInfo[]> {
  const pids = [...new Set(list.map((a) => a.pid).filter((p): p is number => typeof p === "number" && Number.isInteger(p) && p > 0))];
  if (pids.length === 0) return list;
  let stdout = "";
  try {
    // 一部の pid が終わっていても、残りは stdout に出る（全部無いと code 1）。code では捨てずに中身を読む
    stdout = (await run(["ps", "-o", "pid=,tty=,command=", "-p", pids.join(",")])).stdout;
  } catch {
    return list;
  }
  const asked = new Set(pids);
  const headless = new Set<number>();
  for (const line of stdout.split("\n")) {
    const m = line.match(/^\s*(\d+)\s+(\S+)\s+(.*)$/);
    if (!m) continue;
    const pid = Number(m[1]);
    if (!asked.has(pid)) continue;
    // 制御端末が無いと macOS は `??`、Linux は `?` になる
    if (!m[2].startsWith("?")) continue;
    const args = m[3].split(/\s+/);
    if (args.some((t) => t === "-p" || t === "--print")) headless.add(pid);
  }
  return headless.size ? list.filter((a) => a.pid == null || !headless.has(a.pid)) : list;
}

// 公式の既定は /tmp/cc-socks/<pid>.sock。置き場所が不適切なときは /tmp/cc-socks-<uid>/ に置かれる
export function socketPathFor(pid: number, uid: number): string[] {
  return [`/tmp/cc-socks/${pid}.sock`, `/tmp/cc-socks-${uid}/${pid}.sock`];
}

export const bunRunner: Runner = async (cmd) => {
  const p = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe" });
  const stdout = await new Response(p.stdout).text();
  const code = await p.exited;
  return { stdout, code };
};
