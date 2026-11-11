// CLI の親向けの命令。peers、places、ls、show、new、send、read、run、wait、allow、deny、interrupt、stop。参加側の命令は join-commands.ts
import { homedir } from "node:os";
import { isAbsolute, join, resolve as resolvePath } from "node:path";
import type { Config } from "../config";
import type { SessionSummary } from "../sessions/types";
import { describePending } from "../sessions/pending";
import { parseArgs, type Parsed } from "./args";
import { api, clientFor, CliError, readJson, request, type Client } from "./client";
import { matchSession, parseTarget } from "./resolve";
import { lastSeq, rememberSeq } from "./sends";
import { readUntilResult } from "./read";
import { CLI_NAME, configDirOf, SENDS_FILE } from "../names";
import { sameParent } from "../identity/agent-name";

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
type Detail = SessionSummary & { pending: Array<{ requestId: string; toolName: string; input?: Record<string, unknown>; description?: string }>; cursor?: number };
type Peer = { name: string; url: string; status: string; self: boolean };
type PlacesBody = { name?: string; lobby?: string; roots?: string[]; places: Array<{ name: string; path: string; remote: string | null; readme: string[]; lastUsedAt: number | null }>; total: number; truncated: boolean };
const day = (ms: number) => new Date(ms).toLocaleDateString("sv-SE"); // YYYY-MM-DD（手元の時刻）

export const USAGE = `使い方: ${CLI_NAME} <命令> [引数] [--旗]
  ${CLI_NAME} peers                                   登録簿（ノードと状態）
  ${CLI_NAME} places [<語>...] [--peer <名>] [--limit <n>] [--json]
                                                       行き先の候補（roots と Documents の直下、README の先頭、remote、最近使ったか）。語で絞る
  ${CLI_NAME} ls [--peer <名>] [--mine]               セッション一覧（--mine は自分が立てた子）
  ${CLI_NAME} show [<対象>]                           1つの詳細と保留中の承認（対象を省くと、Claude Code の中なら自分のセッション）
  ${CLI_NAME} new [<dir> [<文>]] [--peer <名>] [--mode <permissionMode>] [--model <m>] [--resume <id>] [--as <役割>]
                                                       dir を省くと受け口、文を省くと1通目を待つ（ccn send で送る）
  ${CLI_NAME} send <対象> <文|-> [--as <役割>]         文を送る（- は標準入力）。seq を控える
  ${CLI_NAME} read <対象> [--after <seq>] [--wait <秒>] 返事を読む。終了コード 0 返事、2 時間切れ、3 権限待ち、4 終了
  ${CLI_NAME} run <対象> <文> [--wait <秒>]            send のあと read
  ${CLI_NAME} wait <対象>... [--wait <秒>]             複数を同時に待つ
  ${CLI_NAME} allow <対象> [requestId]                 承認（保留が1件なら省略可）
  ${CLI_NAME} deny <対象> [requestId] <理由>           拒否
  ${CLI_NAME} interrupt <対象> / ${CLI_NAME} stop <対象>
  ${CLI_NAME} setup --hosts <a,b> [--name] [--port] [--cf-token-stdin]   1回だけの準備（cf のある機械で）
  ${CLI_NAME} node add <名> [--port] [--to <file>] / node token <名> [--port] [--to <file>] / node remove <名> [--legacy] / node migrate <名> [--rename]
  ${CLI_NAME} entry <名> [--host <h>] / install [--from <dir>] / update [--from <dir>] [--entry <url>] / uninstall / doctor / serve
<対象> は <peer>/<sessionId の先頭8文字以上> か sessionId。peer を省くと手元のノード`;

const str = (v: string | true | undefined) => (typeof v === "string" ? v : undefined);
const num = (v: string | true | undefined, d: number) => { const n = Number(str(v)); return Number.isFinite(n) && str(v) !== undefined ? n : d; };
const sendsPath = (ctx: Ctx) => ctx.sendsPath ?? join(configDirOf(ctx.env.HOME ?? homedir()), SENDS_FILE);
const id8 = (id: string) => id.slice(0, 8);

const FULL_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// 完全な sessionId なら詳細を1回だけ引く。先頭8文字以上なら一覧から絞る
async function resolve(ctx: Ctx, target: string, role?: string): Promise<{ c: Client; s: SessionSummary; key: string; d?: Detail }> {
  const t = parseTarget(target);
  const c = clientFor(ctx.cfg, t.peer, role, ctx.env);
  if (FULL_ID.test(t.id)) {
    const path = `/api/sessions/${t.id}`;
    const r = await request(c, "GET", path, undefined, ctx.fetchFn);
    if (r.status === 404) { await r.body?.cancel().catch(() => {}); throw new CliError(1, `「${t.id}」に当たるセッションが無い。${CLI_NAME} ls で確かめる`); }
    const d = await readJson<Detail>(c, "GET", path, r);
    return { c, s: d, key: `${c.peer}/${d.id}`, d };
  }
  const list = await api<SessionSummary[]>(c, "GET", "/api/sessions", undefined, ctx.fetchFn);
  const s = matchSession(list, t.id);
  return { c, s, key: `${c.peer}/${s.id}` };
}
const detailOf = async (ctx: Ctx, r: { c: Client; s: SessionSummary; d?: Detail }): Promise<Detail> => r.d ?? api<Detail>(r.c, "GET", `/api/sessions/${r.s.id}`, undefined, ctx.fetchFn);
async function peersOf(ctx: Ctx): Promise<Peer[]> {
  const local = clientFor(ctx.cfg, undefined, undefined, ctx.env);
  return api<Peer[]>(local, "GET", "/api/peers", undefined, ctx.fetchFn);
}
// 送る前の末尾の seq（live は最後の seq、履歴は末尾の offset）。詳細に cursor が無い古いノード用に、messages をたどって数える
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
  const r = await resolve(ctx, target, str(flags.as));
  const { c, s, key } = r;
  const d = await detailOf(ctx, r);
  const seq = typeof d.cursor === "number" ? d.cursor : await endCursor(ctx, c, s);
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
    case "places": {
      const c = clientFor(ctx.cfg, str(flags.peer), undefined, ctx.env);
      const qs = new URLSearchParams();
      if (rest.length) qs.set("q", rest.join(" "));
      if (str(flags.limit)) qs.set("limit", str(flags.limit)!);
      const path = `/api/places${qs.size ? `?${qs}` : ""}`;
      const r = await request(c, "GET", path, undefined, ctx.fetchFn);
      if (r.status === 404) { await r.body?.cancel().catch(() => {}); throw new CliError(1, `${c.peer} のノードは places に対応していない古い版。${c.peer} で ${CLI_NAME} update する`); }
      const b = await readJson<PlacesBody>(c, "GET", path, r);
      if (flags.json) { ctx.out(JSON.stringify(b, null, 1)); return 0; }
      if (b.lobby) ctx.out(`lobby: ${b.lobby}`);
      if (b.roots) ctx.out(`roots: ${b.roots.join(", ")}`);
      for (const p of b.places) {
        ctx.out([p.path, p.remote ? `remote=${p.remote}` : "", p.lastUsedAt ? `used=${day(p.lastUsedAt)}` : ""].filter(Boolean).join("  "));
        for (const l of p.readme) ctx.out(`  | ${l}`);
      }
      ctx.out(b.truncated ? `(${b.total} 件のうち ${b.places.length} 件。語で絞る: ${CLI_NAME} places <語>)` : `(${b.total} 件)`);
      return 0;
    }
    case "ls": {
      const all = str(flags.peer) ? [{ name: str(flags.peer)!, status: "healthy" } as Peer] : await peersOf(ctx).catch(() => [{ name: ctx.cfg.name, status: "healthy" }] as Peer[]);
      // --mine は自分（このノードと自分の sessionId）が名乗った親の子だけ。役割は問わない
      const mine = flags.mine ? (parent: string | undefined) => sameParent(parent, ctx.cfg.name, ctx.env.CLAUDE_CODE_SESSION_ID) : undefined;
      const rows = await Promise.all(all.map(async ({ name: peer, status }) => {
        if (status !== "healthy" && status !== "degraded") return [`${peer}  (${status})`]; // 落ちている相手は呼ばない
        try {
          const c = clientFor(ctx.cfg, peer, undefined, ctx.env);
          const list = await api<SessionSummary[]>(c, "GET", "/api/sessions", undefined, ctx.fetchFn);
          return list.filter((s) => !mine || mine(s.parent)).map((s) => line(peer, s));
        } catch (e) { return [`${peer}  (読めない: ${e instanceof Error ? e.message : String(e)})`]; }
      }));
      for (const r of rows.flat()) ctx.out(r);
      return 0;
    }
    case "show": {
      // 対象を省くと自分（Claude Code が渡す CLAUDE_CODE_SESSION_ID）。受け口が変数を書かずに自分の permissionMode を読むため
      const self = ctx.env.CLAUDE_CODE_SESSION_ID;
      if (rest[0] === undefined && !self) throw new CliError(1, "show には 対象 が要る（Claude Code の中では省くと自分のセッション）");
      const r = await resolve(ctx, rest[0] ?? `${ctx.cfg.name}/${self}`);
      const { c } = r;
      const d = await detailOf(ctx, r);
      const caps = Object.entries(d.capabilities).filter(([, v]) => v).map(([k]) => k).join(",");
      for (const [k, v] of [["id", d.id], ["peer", c.peer], ["kind", d.kind], ["state", d.state], ["cwd", d.cwd], ["model", d.model], ["permissionMode", d.permissionMode], ["parent", d.parent], ["title", d.title], ["pid", d.pid], ["exitReason", d.exitReason], ["capabilities", caps], ["usage", d.usage ? JSON.stringify(d.usage) : undefined]] as const) {
        if (v !== undefined && v !== "") ctx.out(`${k}: ${String(v)}`);
      }
      for (const p of d.pending ?? []) ctx.out(`pending: ${p.requestId} ${describePending(p)}`);
      return 0;
    }
    case "new": {
      // ccn new → 受け口、ccn new <dir> → その場所、どちらも1通目は ccn send で送る。ccn new <dir> <文> は今までどおり
      const c = clientFor(ctx.cfg, str(flags.peer), str(flags.as), ctx.env);
      const body: Record<string, unknown> = { permissionMode: str(flags.mode) ?? "bypassPermissions" };
      if (rest[0] !== undefined) {
        // 相対パスはノードの作業ディレクトリ（ホーム）で解かれてしまうので、手元なら CLI の場所で解き、相手なら断る
        let cwd = rest[0];
        if (!isAbsolute(cwd)) {
          if (c.peer !== ctx.cfg.name) throw new CliError(1, `相手のノード（${c.peer}）には絶対パスで指定する: ${cwd}`);
          cwd = resolvePath(cwd);
        }
        body.cwd = cwd;
      }
      if (rest[1] !== undefined) body.prompt = rest[1];
      if (str(flags.model)) body.model = str(flags.model);
      if (str(flags.resume)) body.resume = str(flags.resume);
      let r: { id: string };
      try { r = await api<{ id: string }>(c, "POST", "/api/sessions", body, ctx.fetchFn); }
      catch (e) {
        // 受け口とプロンプト無しの作成を知らない古い版のノードは、cwd か prompt が無いと 400 で断る
        if (e instanceof CliError && body.prompt === undefined && !body.resume && /cwd is required|prompt or resume is required/.test(e.message)) {
          throw new CliError(1, `${e.message}\n${c.peer} のノードは受け口とプロンプト無しの作成に対応していない古い版。${c.peer} で ${CLI_NAME} update するか、${CLI_NAME} new <dir> <文> で立てる`);
        }
        throw e;
      }
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
      const r = await resolve(ctx, rest[0]!);
      const { c, s } = r;
      const d = await detailOf(ctx, r);
      const pending = d.pending ?? [];
      let rid: string | undefined = rest[1];
      let reason = rest[2];
      if (cmd === "deny" && rid && !reason && !pending.some((p) => p.requestId === rid)) { reason = rid; rid = undefined; }
      if (!rid) {
        if (pending.length === 1) rid = pending[0]!.requestId;
        else throw new CliError(1, pending.length === 0 ? "保留中の承認が無い" : `保留が複数ある。requestId を指定する:\n${pending.map((p) => `  ${p.requestId} ${describePending(p)}`).join("\n")}`);
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
