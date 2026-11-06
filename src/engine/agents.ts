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
