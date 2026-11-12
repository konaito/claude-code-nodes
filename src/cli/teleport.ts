// ccn teleport。--to があれば移動元のノードに進めさせ（POST /api/sessions/:id/teleport）、無ければ手元の端末へ持ってくる。
// 手元へ持ってくるときは、端末の claude と同じ CLAUDE_CONFIG_DIR に書くため、CLI のプロセスの中で取り込む
import type { Parsed } from "./args";
import { api, CliError, readJson, request, type Client } from "./client";
import { decodePack } from "../teleport/pack";
import { resolveDest, type CheckInput, type PlaceDeps } from "../teleport/place";
import { importPack, type ImportResult, type TeleportDeps } from "../teleport/teleport";
import { CLI_NAME } from "../names";

export type PullDeps = {
  teleport: TeleportDeps; place: PlaceDeps; open: (cwd: string, id: string) => Promise<number>; interactive: boolean;
  // 手元で同じ id が動いているか（手元のノードの台帳と端末）。動いていれば取り込まない
  localLive?: (id: string) => Promise<boolean>;
};
// 古い版のノードは道が無く、本文が {"error":"not found"} の 404 を返す。unknown session や unknown peer とは分ける
const isOldVersion = async (r: Response) => r.status === 404 && /"error":"not found"/.test(await r.clone().text());
type Info = CheckInput & { id: string; kind: string; state: string; live: boolean; awaitingFirst: boolean };
type Out = (s: string) => void;

const shq = (s: string) => (/^[A-Za-z0-9_./@%+=:,-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`);
const str = (v: string | true | undefined) => (typeof v === "string" ? v : undefined);

function report(out: Out, peer: string, r: { id: string; cwd: string; cloned?: boolean; fork?: boolean; git?: ImportResult["git"]; warnings?: string[] }) {
  out(`${peer}/${r.id}`);
  out(`cwd: ${r.cwd}${r.cloned ? "（clone した）" : ""}`);
  if (r.git) out(`git: ${r.git.branch ?? "(detached)"} ${r.git.head.slice(0, 8)}（前は ${r.git.previous.branch ?? "(detached)"} ${r.git.previous.head?.slice(0, 8) ?? "-"}）`);
  out(`mode: ${r.fork ? "fork（移動元はそのまま、別の id）" : "move（移動元は止めた）"}`);
  for (const w of r.warnings ?? []) out(`warning: ${w}`);
}

// 移動元のノードに進めさせる（相手のノードへ）
export async function push(c: Client, id: string, to: string, flags: Parsed["flags"], out: Out, fetchFn: typeof fetch): Promise<{ id: string }> {
  const body = { to, fork: flags.fork === true, ...(str(flags.cwd) ? { cwd: str(flags.cwd) } : {}) };
  const r = await request(c, "POST", `/api/sessions/${id}/teleport`, body, fetchFn);
  if (await isOldVersion(r)) throw new CliError(1, `${c.peer} のノードは teleport に対応していない古い版。${c.peer} で ${CLI_NAME} update する`);
  const res = await readJson<{ id: string; cwd: string; cloned: boolean; fork: boolean; git: ImportResult["git"]; warnings: string[]; resume?: string }>(c, "POST", `/api/sessions/${id}/teleport`, r);
  report(out, to, res);
  out(`続ける: ${CLI_NAME} send ${to}/${res.id} <文>`);
  if (res.resume) out(`30分 send しないと ${to} の台帳から消える。そのあとは: ${res.resume}`);
  return res;
}

// 手元の端末へ持ってくる。下見（clone を含む）、移動元の書き出し（move なら止める）、取り込み、claude --resume の順
export async function pull(c: Client, id: string, flags: Parsed["flags"], out: Out, fetchFn: typeof fetch, deps: PullDeps): Promise<number> {
  const fork = flags.fork === true;
  const ir = await request(c, "GET", `/api/sessions/${id}/teleport`, undefined, fetchFn);
  if (await isOldVersion(ir)) throw new CliError(1, `${c.peer} のノードは teleport に対応していない古い版。${c.peer} で ${CLI_NAME} update する`);
  const info = await readJson<Info>(c, "GET", `/api/sessions/${id}/teleport`, ir);
  if (info.awaitingFirst) throw new CliError(1, "まだ1通も届いていないセッションなので、運ぶ会話が無い");
  if (!fork && (await deps.localLive?.(id))) throw new CliError(1, `${id} は手元で動いている。止めてからやり直すか、--fork で別の id にする`);
  const dest = await resolveDest({ id, fork, from: info.from, git: info.git }, str(flags.cwd), deps.place).catch((e) => { throw new CliError(1, `移動先を決められない: ${e instanceof Error ? e.message : String(e)}`); });
  const er = await request(c, "POST", `/api/sessions/${id}/export`, { fork }, fetchFn);
  if (!er.ok) await readJson(c, "POST", `/api/sessions/${id}/export`, er);
  const pack = decodePack(new Uint8Array(await er.arrayBuffer()));
  let r: ImportResult;
  try { r = await importPack({ ...deps.teleport, place: deps.place }, pack, { dest }); }
  catch (e) {
    const hint = pack.fork ? "" : `\n移動元は止めた。${c.peer} で続けるなら: ${CLI_NAME} new ${info.from.cwd} --peer ${c.peer} --resume ${id}`;
    throw new CliError(1, `取り込めなかった: ${e instanceof Error ? e.message : String(e)}${hint}`);
  }
  report(out, "手元", { ...r, fork: pack.fork });
  if (deps.interactive && !flags["no-open"]) return deps.open(r.cwd, r.id);
  out(`開く: cd ${shq(r.cwd)} && claude --resume ${r.id}`);
  return 0;
}

// 手元の places（ノードの roots と Documents の直下）。手元のノードに聞く
export const localPlaces = (local: Client, fetchFn: typeof fetch) => async () =>
  (await api<{ places: Array<{ path: string; remote: string | null }> }>(local, "GET", "/api/places?limit=300", undefined, fetchFn)).places;
