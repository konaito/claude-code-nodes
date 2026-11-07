// cc の親向けの命令。peers、ls、show、new、send、read、run、wait、allow、deny、interrupt、stop。参加側の命令は join-commands.ts
import { homedir } from "node:os";
import { isAbsolute, join, resolve as resolvePath } from "node:path";
import type { Config } from "../config";
import type { SessionSummary } from "../sessions/types";
import { parseArgs, type Parsed } from "./args";
import { api, clientFor, CliError, type Client } from "./client";
import { matchSession, parseTarget } from "./resolve";
import { lastSeq, rememberSeq } from "./sends";
import { readUntilResult } from "./read";
import { CLI_NAME } from "./name";

export type Ctx = {
  cfg: Config;
  env: Record<string, string | undefined>;
  out: (s: string) => void;
  err?: (s: string) => void;
  fetchFn: typeof fetch;
  stdin: () => Promise<string>;
  sendsPath?: string;
  pollMs?: number;
  now?: () => number;
  // 参加側の命令（join-commands.ts）が使う
  join?: (words: string[], flags: Parsed["flags"], ctx: Ctx) => Promise<number | undefined>;
};
type Detail = SessionSummary & { pending: Array<{ requestId: string; toolName: string; description?: string }> };
type Peer = { name: string; url: string; status: string; self: boolean };

export const USAGE = `使い方: ${CLI_NAME} <命令> [引数] [--旗]
  ${CLI_NAME} peers                                   登録簿（ノードと状態）
  ${CLI_NAME} ls [--peer <名>] [--mine]               セッション一覧（--mine は自分が立てた子）
  ${CLI_NAME} show <対象>                             1つの詳細と保留中の承認
  ${CLI_NAME} new <dir> <文> [--peer <名>] [--mode <permissionMode>] [--model <m>] [--resume <id>] [--as <役割>]
  ${CLI_NAME} send <対象> <文|-> [--as <役割>]         文を送る（- は標準入力）。seq を控える
  ${CLI_NAME} read <対象> [--after <seq>] [--wait <秒>] 返事を読む。終了コード 0 返事、2 時間切れ、3 権限待ち、4 終了
  ${CLI_NAME} run <対象> <文> [--wait <秒>]            send のあと read
  ${CLI_NAME} wait <対象>... [--wait <秒>]             複数を同時に待つ
  ${CLI_NAME} allow <対象> [requestId]                 承認（保留が1件なら省略可）
  ${CLI_NAME} deny <対象> [requestId] <理由>           拒否
  ${CLI_NAME} interrupt <対象> / ${CLI_NAME} stop <対象>
  ${CLI_NAME} setup --hosts <a,b> [--name] [--port] [--cf-token-stdin]   1回だけの準備（cf のある機械で）
  ${CLI_NAME} node add <名> [--port] [--to <file>] / node token <名> [--port] [--to <file>] / node remove <名> / entry <名> / install [--from <dir>] / update [--from <dir>] / uninstall / doctor / serve
<対象> は <peer>/<sessionId の先頭8文字以上> か sessionId。peer を省くと手元のノード`;

const str = (v: string | true | undefined) => (typeof v === "string" ? v : undefined);
const num = (v: string | true | undefined, d: number) => { const n = Number(str(v)); return Number.isFinite(n) && str(v) !== undefined ? n : d; };
const sendsPath = (ctx: Ctx) => ctx.sendsPath ?? join(ctx.env.HOME ?? homedir(), ".config", "cc", "sends.json");
const id8 = (id: string) => id.slice(0, 8);

async function resolve(ctx: Ctx, target: string, role?: string): Promise<{ c: Client; s: SessionSummary; key: string }> {
  const t = parseTarget(target);
  const c = clientFor(ctx.cfg, t.peer, role, ctx.env);
  const list = await api<SessionSummary[]>(c, "GET", "/api/sessions", undefined, ctx.fetchFn);
  const s = matchSession(list, t.id);
  return { c, s, key: `${c.peer}/${s.id}` };
}
async function peersOf(ctx: Ctx): Promise<Peer[]> {
  const local = clientFor(ctx.cfg, undefined, undefined, ctx.env);
  return api<Peer[]>(local, "GET", "/api/peers", undefined, ctx.fetchFn);
}
// 送る前の末尾の seq（live は最後の seq、履歴は末尾の offset）
async function endCursor(ctx: Ctx, c: Client, s: SessionSummary): Promise<number> {
  let cur = 0;
  for (let i = 0; i < 1000; i++) {
    const page = await api<{ messages: unknown[]; next?: number }>(c, "GET", `/api/sessions/${s.id}/messages?after=${cur}`, undefined, ctx.fetchFn);
    if (page.next === undefined || page.next === cur) return cur;
    cur = page.next;
  }
  return cur;
}
const line = (peer: string, s: SessionSummary) => [`${peer}/${id8(s.id)}`, s.kind.padEnd(8), s.state.padEnd(18), s.cwd, s.parent ?? "-", s.title ?? ""].join("  ");

async function read(ctx: Ctx, target: string, flags: Parsed["flags"]): Promise<number> {
  const { c, s, key } = await resolve(ctx, target);
  const after = str(flags.after) !== undefined ? num(flags.after, 0) : lastSeq(key, sendsPath(ctx)) ?? 0;
  const r = await readUntilResult(c, s, after, num(flags.wait, 120), ctx.out, { fetchFn: ctx.fetchFn, pollMs: ctx.pollMs, now: ctx.now });
  rememberSeq(key, r.seq, sendsPath(ctx));
  return r.code;
}
async function send(ctx: Ctx, target: string, text: string, flags: Parsed["flags"]): Promise<number> {
  const body = text === "-" ? await ctx.stdin() : text;
  if (!body.trim()) throw new CliError(1, "文が空");
  const { c, s, key } = await resolve(ctx, target, str(flags.as));
  const seq = await endCursor(ctx, c, s);
  await api(c, "POST", `/api/sessions/${s.id}/messages`, { text: body }, ctx.fetchFn);
  rememberSeq(key, seq, sendsPath(ctx));
  ctx.out(`seq=${seq}`);
  return 0;
}

export async function main(argv: string[], ctx: Ctx): Promise<number> {
  const { words, flags } = parseArgs(argv);
  const [cmd, ...rest] = words;
  const err = ctx.err ?? ((s) => console.error(s));
  try {
    const code = await run(cmd, rest, flags, ctx);
    if (code === undefined) { ctx.out(USAGE); return 1; }
    return code;
  } catch (e) {
    if (e instanceof CliError) { err(e.message); return e.code; }
    err(e instanceof Error ? e.message : String(e));
    return 1;
  }
}

async function run(cmd: string | undefined, rest: string[], flags: Parsed["flags"], ctx: Ctx): Promise<number | undefined> {
  if (!cmd || cmd === "help" || flags.help) return undefined;
  const need = (n: number, what: string) => { if (rest.length < n) throw new CliError(1, `${cmd} には ${what} が要る`); };
  switch (cmd) {
    case "peers": {
      for (const p of await peersOf(ctx)) ctx.out(`${p.name} ${p.status} ${p.url}${p.self ? " (self)" : ""}`);
      return 0;
    }
    case "ls": {
      const all = str(flags.peer) ? [{ name: str(flags.peer)!, status: "healthy" } as Peer] : await peersOf(ctx).catch(() => [{ name: ctx.cfg.name, status: "healthy" }] as Peer[]);
      const mine = flags.mine ? `agent:${clientFor(ctx.cfg, undefined, undefined, ctx.env).headers["x-cc-from"]!.slice("agent:".length).split("/").slice(0, 2).join("/")}/` : undefined;
      const rows = await Promise.all(all.map(async ({ name: peer, status }) => {
        if (status !== "healthy" && status !== "degraded") return [`${peer}  (${status})`]; // 落ちている相手は呼ばない
        try {
          const c = clientFor(ctx.cfg, peer, undefined, ctx.env);
          const list = await api<SessionSummary[]>(c, "GET", "/api/sessions", undefined, ctx.fetchFn);
          return list.filter((s) => !mine || (s.parent ?? "").startsWith(mine)).map((s) => line(peer, s));
        } catch (e) { return [`${peer}  (読めない: ${e instanceof Error ? e.message : String(e)})`]; }
      }));
      for (const r of rows.flat()) ctx.out(r);
      return 0;
    }
    case "show": {
      need(1, "対象");
      const { c, s } = await resolve(ctx, rest[0]!);
      const d = await api<Detail>(c, "GET", `/api/sessions/${s.id}`, undefined, ctx.fetchFn);
      const caps = Object.entries(d.capabilities).filter(([, v]) => v).map(([k]) => k).join(",");
      for (const [k, v] of [["id", d.id], ["peer", c.peer], ["kind", d.kind], ["state", d.state], ["cwd", d.cwd], ["model", d.model], ["permissionMode", d.permissionMode], ["parent", d.parent], ["title", d.title], ["pid", d.pid], ["exitReason", d.exitReason], ["capabilities", caps], ["usage", d.usage ? JSON.stringify(d.usage) : undefined]] as const) {
        if (v !== undefined && v !== "") ctx.out(`${k}: ${String(v)}`);
      }
      for (const p of d.pending ?? []) ctx.out(`pending: ${p.requestId} ${p.toolName} ${p.description ?? ""}`.trim());
      return 0;
    }
    case "new": {
      need(2, "<dir> と <文>");
      const c = clientFor(ctx.cfg, str(flags.peer), str(flags.as), ctx.env);
      // 相対パスはノードの作業ディレクトリ（ホーム）で解かれてしまうので、手元なら CLI の場所で解き、相手なら断る
      let cwd = rest[0]!;
      if (!isAbsolute(cwd)) {
        if (c.peer !== ctx.cfg.name) throw new CliError(1, `相手のノード（${c.peer}）には絶対パスで指定する: ${cwd}`);
        cwd = resolvePath(cwd);
      }
      const body: Record<string, unknown> = { cwd, prompt: rest[1], permissionMode: str(flags.mode) ?? "bypassPermissions" };
      if (str(flags.model)) body.model = str(flags.model);
      if (str(flags.resume)) body.resume = str(flags.resume);
      const r = await api<{ id: string }>(c, "POST", "/api/sessions", body, ctx.fetchFn);
      rememberSeq(`${c.peer}/${r.id}`, 0, sendsPath(ctx));
      ctx.out(`${c.peer}/${r.id}`);
      return 0;
    }
    case "send": { need(2, "<対象> と <文>"); return send(ctx, rest[0]!, rest[1]!, flags); }
    case "read": { need(1, "対象"); return read(ctx, rest[0]!, flags); }
    case "run": {
      need(2, "<対象> と <文>");
      await send(ctx, rest[0]!, rest[1]!, flags);
      const { after: _after, ...rest2 } = flags;
      return read(ctx, rest[0]!, rest2);
    }
    case "wait": {
      need(1, "対象");
      const codes = await Promise.all(rest.map(async (t) => { const lines: string[] = []; const code = await read({ ...ctx, out: (s) => lines.push(s) }, t, flags).catch((e) => { lines.push(String(e instanceof Error ? e.message : e)); return 1; }); return { t, code, lines }; }));
      for (const r of codes) { ctx.out(`== ${r.t}`); for (const l of r.lines) ctx.out(l); }
      return Math.max(...codes.map((r) => r.code));
    }
    case "allow":
    case "deny": {
      need(1, "対象");
      const { c, s } = await resolve(ctx, rest[0]!);
      const d = await api<Detail>(c, "GET", `/api/sessions/${s.id}`, undefined, ctx.fetchFn);
      const pending = d.pending ?? [];
      let rid: string | undefined = rest[1];
      let reason = rest[2];
      if (cmd === "deny" && rid && !reason && !pending.some((p) => p.requestId === rid)) { reason = rid; rid = undefined; }
      if (!rid) {
        if (pending.length === 1) rid = pending[0]!.requestId;
        else throw new CliError(1, pending.length === 0 ? "保留中の承認が無い" : `保留が複数ある。requestId を指定する:\n${pending.map((p) => `  ${p.requestId} ${p.toolName}`).join("\n")}`);
      }
      if (cmd === "deny" && !reason) throw new CliError(1, "deny には理由が要る");
      await api(c, "POST", `/api/sessions/${s.id}/permissions/${rid}`, cmd === "allow" ? { behavior: "allow" } : { behavior: "deny", message: reason }, ctx.fetchFn);
      ctx.out(`${cmd} ${rid}`);
      return 0;
    }
    case "interrupt": {
      need(1, "対象");
      const { c, s } = await resolve(ctx, rest[0]!);
      await api(c, "POST", `/api/sessions/${s.id}/interrupt`, {}, ctx.fetchFn);
      return 0;
    }
    case "stop": {
      need(1, "対象");
      const { c, s } = await resolve(ctx, rest[0]!);
      await api(c, "DELETE", `/api/sessions/${s.id}`, undefined, ctx.fetchFn);
      return 0;
    }
    default:
      return ctx.join ? ctx.join([cmd, ...rest], flags, ctx) : undefined;
  }
}
