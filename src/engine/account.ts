// 子の claude をどのアカウントで起動するか。cam（Claude Account Manager、~/.cam）がある機械では、`cam auto` と同じく
// `cam usage --json` の best のコマンドで起動する。cam の launcher（~/.cam/bin/<名前>）は `cam sync <名前>` の後に
// CLAUDE_CONFIG_DIR=~/.cam/profiles/<名前> で claude を起動し、プロファイルの無い --default のコマンドは env を触らずに起動する。ここも同じにする。
// 選べないとき（cam が無い、JSON が読めない、best が null）は env を触らず、ノードと同じ設定（今まで通り）で起動する
import { join } from "node:path";
import { stat } from "node:fs/promises";

// いちばん早く枠が戻るコマンドと、その時刻（ミリ秒。cam は秒で返す）
export type NextAvailable = { account: string; at: number };
export type AccountChoice = {
  name?: string;      // 選んだ cam のコマンド。選べなければ無い
  email?: string;     // そのコマンドの email（cam usage の accounts から）。分からなければ無い
  configDir?: string; // 子に渡す CLAUDE_CONFIG_DIR。--default のコマンドと、選べないときは無い（ノードの env のまま）
  // cam が「枠の残るコマンドが無い」（choice: none）と答えた。cam が無い、落ちた、判定できないときは付かない
  none?: { nextAvailable: NextAvailable | null };
  reason: string;     // ログに出す一言
};
// fresh は使い回しを使わずに cam usage を取り直す（引き継ぎ。上限で止まった直後に呼ばれるので、古い best だと前任と同じアカウントになる）
export type Picker = ((o?: { fresh?: boolean }) => Promise<AccountChoice>) & { emailOf: (name: string) => string | undefined };
export type Exec = (argv: string[], timeoutMs: number) => Promise<{ stdout: string; code: number | null }>;
export type AccountDeps = {
  cam?: string;          // cam の実行ファイル。無ければ選ばない
  profilesDir: string;   // ~/.cam/profiles
  exec: Exec;
  isDir?: (p: string) => Promise<boolean>;
  now?: () => number;
  ttlMs?: number;        // 結果を使い回す時間。既定 30 秒。usage の API は 429 を返しやすい（cam の README）
  timeoutMs?: number;    // cam usage を待つ上限。既定 5 秒。過ぎたら止めて今まで通りにする
  log?: (msg: string) => void;
};

const NAME = /^[a-z][a-z0-9_-]*$/; // cam のコマンド名の決まり（cam の valid_name）
const isDirOf = async (p: string) => (await stat(p).catch(() => null))?.isDirectory() ?? false;

// 選ぶ関数を返す。結果は ttl の間使い回し、同時の呼び出しは1回の cam usage にまとめる。
// fresh を渡すと使い回さずに取り直す（走っている最中の cam usage があれば、それを待つ）。取り直した結果は次の呼び出しが使い回す。
// emailOf は、最後に読めた cam usage の accounts から名前で email を引く（端末のセッションのアカウントに使う）
export function camAccount(deps: AccountDeps): Picker {
  const now = deps.now ?? Date.now;
  const ttl = deps.ttlMs ?? 30_000;
  const emails = new Map<string, string>();
  let cached: { at: number; p: Promise<AccountChoice> } | undefined;
  let running: Promise<AccountChoice> | undefined;
  const fn = (o?: { fresh?: boolean }) => {
    if (running) return running;
    if (!o?.fresh && cached && now() - cached.at < ttl) return cached.p;
    const p: Promise<AccountChoice> = pick(deps, emails).then((c) => { deps.log?.(`account: ${c.name ?? "-"} (${c.reason})`); return c; }).finally(() => { if (running === p) running = undefined; });
    running = p;
    cached = { at: now(), p };
    return p;
  };
  return Object.assign(fn, { emailOf: (name: string) => emails.get(name) });
}

async function pick(deps: AccountDeps, emails: Map<string, string>): Promise<AccountChoice> {
  if (!deps.cam) return { reason: "cam not found; using the node's claude config" };
  let r: { stdout: string; code: number | null };
  try {
    r = await deps.exec([deps.cam, "usage", "--json"], deps.timeoutMs ?? 5000);
  } catch (e) {
    return { reason: `cam usage failed: ${e instanceof Error ? e.message : String(e)}; using the node's claude config` };
  }
  if (r.code !== 0) return { reason: `cam usage exited ${r.code}; using the node's claude config` };
  let v: { best?: unknown; choice?: unknown; next_available?: { name?: unknown; at?: unknown } | null; accounts?: unknown };
  try {
    v = JSON.parse(r.stdout);
  } catch {
    return { reason: "cam usage did not return JSON; using the node's claude config" };
  }
  if (Array.isArray(v?.accounts)) {
    for (const a of v.accounts as { name?: unknown; email?: unknown }[]) {
      if (typeof a?.name === "string" && NAME.test(a.name) && typeof a.email === "string" && a.email) emails.set(a.name, a.email);
    }
  }
  if (typeof v?.best !== "string" || !v.best) {
    const n = v?.next_available && typeof v.next_available.name === "string" && typeof v.next_available.at === "number" ? { account: v.next_available.name, at: v.next_available.at * 1000 } : null;
    const next = n ? `, next: ${n.account} at ${new Date(n.at).toISOString()}` : "";
    return { ...(v?.choice === "none" ? { none: { nextAvailable: n } } : {}), reason: `cam has no usable account (choice: ${String(v?.choice)}${next}); using the node's claude config` };
  }
  if (!NAME.test(v.best)) return { reason: `cam returned an invalid name: ${v.best}; using the node's claude config` };
  const email = emails.get(v.best);
  // launcher と1字も違わないパスにする。Keychain の項目名がこのパスの sha256 で決まるので、realpath や末尾の / で変えない
  const dir = join(deps.profilesDir, v.best);
  if (await (deps.isDir ?? isDirOf)(dir)) return { name: v.best, ...(email ? { email } : {}), configDir: dir, reason: `cam usage best (${String(v.choice)})` };
  return { name: v.best, ...(email ? { email } : {}), reason: `cam usage best (${String(v.choice)}), a --default command; using the node's claude config` };
}

// 子に渡す環境。configDir があるときだけ CLAUDE_CONFIG_DIR を差し替える
export function withAccount<T extends Record<string, string | undefined>>(env: T, c: AccountChoice | undefined): T {
  return c?.configDir ? { ...env, CLAUDE_CONFIG_DIR: c.configDir } : env;
}

// 起動の直前の用意。選んだプロファイルに launcher と同じく `cam sync` を掛け（共有のリンクと MCP と信頼済みフォルダの同期）、
// cwd をそのプロファイルの .claude.json で信頼済みにする（#46。claude は CLAUDE_CONFIG_DIR の中の .claude.json を読む）。
// 返すのは子の環境と、選んだアカウント（一覧に出す）。プロファイルを選ばなかったときは env が無い（ノードの env のまま）。
// --default のコマンドは env を触らないが、ノードの設定がそのアカウントなので account は返す。選べなかったときは account も無い
export type Prepared = { env?: Record<string, string | undefined>; account?: string; accountEmail?: string };
export type PrepareDeps = {
  pick: () => Promise<AccountChoice>;
  env: () => Record<string, string | undefined>;
  sync?: (name: string) => Promise<unknown>;
  trust?: (cwd: string, configFile: string) => Promise<unknown>;
};
export function accountPreparer(d: PrepareDeps): (cwd: string) => Promise<Prepared> {
  return async (cwd) => {
    const a = await d.pick().catch(() => undefined);
    if (!a?.name) return {};
    const who = { account: a.name, ...(a.email ? { accountEmail: a.email } : {}) };
    if (!a.configDir) return who;
    await d.sync?.(a.name).catch(() => {});
    await d.trust?.(cwd, join(a.configDir, ".claude.json")).catch(() => {});
    return { env: withAccount(d.env(), a), ...who };
  };
}

// 端末のセッション（人が起動した claude）のアカウント。プロセスの環境の CLAUDE_CONFIG_DIR が <profilesDir>/<名前> なら、その名前を返す。
// ps の出力は引数の後ろに環境が続く。引数だけの出力を頭から除いた残りを環境として読むので、引数（最初の文など）の中の文字列には当たらない。
// 読めないとき（ps が落ちる、環境が見えない、プロファイルの外）は undefined。pid と起動時刻ごとに1回だけ読む
export type PidAccountDeps = {
  profilesDir: string;
  run: (argv: string[]) => Promise<{ stdout: string; code: number | null }>;
  emailOf?: (name: string) => string | undefined | Promise<string | undefined>;
};
const PID_CACHE_MAX = 256;
export function pidAccount(deps: PidAccountDeps): (pid: number | undefined, startedAt?: number) => Promise<{ account: string; accountEmail?: string } | undefined> {
  const cache = new Map<string, Promise<string | undefined>>();
  const read = async (pid: number) => {
    const [argv, full] = await Promise.all([deps.run(["ps", "ww", "-o", "command=", "-p", String(pid)]), deps.run(["ps", "eww", "-o", "command=", "-p", String(pid)])]);
    return accountFromPs(argv.stdout, full.stdout, deps.profilesDir);
  };
  return async (pid, startedAt) => {
    if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) return undefined;
    const key = `${pid}:${startedAt ?? 0}`;
    let p = cache.get(key);
    if (!p) {
      p = read(pid).catch(() => undefined);
      cache.set(key, p);
      if (cache.size > PID_CACHE_MAX) cache.delete(cache.keys().next().value!);
    }
    const name = await p;
    if (!name) return undefined;
    const email = await Promise.resolve(deps.emailOf?.(name)).catch(() => undefined);
    return { account: name, ...(email ? { accountEmail: email } : {}) };
  };
}
// argv は `ps ww -o command=`、withEnv は `ps eww -o command=` の出力
export function accountFromPs(argv: string, withEnv: string, profilesDir: string): string | undefined {
  const a = argv.replace(/\n+$/, "");
  const f = withEnv.replace(/\n+$/, "");
  if (!a || !f.startsWith(a)) return undefined;
  const m = /(?:^|\s)CLAUDE_CONFIG_DIR=(\S+)/.exec(f.slice(a.length));
  if (!m) return undefined;
  const base = profilesDir.endsWith("/") ? profilesDir : `${profilesDir}/`;
  if (!m[1]!.startsWith(base)) return undefined;
  const name = m[1]!.slice(base.length).replace(/\/$/, "");
  return NAME.test(name) ? name : undefined;
}

// 上限時間つきで実行する。過ぎたら止めて投げる
export const bunExec: Exec = async (argv, timeoutMs) => {
  const p = Bun.spawn(argv, { stdout: "pipe", stderr: "ignore", stdin: "ignore" });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => { p.kill(); reject(new Error(`timed out after ${timeoutMs}ms`)); }, timeoutMs);
  });
  try {
    return await Promise.race([(async () => ({ stdout: await new Response(p.stdout).text(), code: await p.exited }))(), timeout]);
  } finally {
    clearTimeout(timer);
  }
};
