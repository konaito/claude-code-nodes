// 子の claude をどのアカウントで起動するか。cam（Claude Account Manager、~/.cam）がある機械では、`cam auto` と同じく
// `cam usage --json` の best のコマンドで起動する。cam の launcher（~/.cam/bin/<名前>）は `cam sync <名前>` の後に
// CLAUDE_CONFIG_DIR=~/.cam/profiles/<名前> で claude を起動し、プロファイルの無い --default のコマンドは env を触らずに起動する。ここも同じにする。
// 選べないとき（cam が無い、JSON が読めない、best が null）は env を触らず、ノードと同じ設定（今まで通り）で起動する
import { join } from "node:path";
import { stat } from "node:fs/promises";

export type AccountChoice = {
  name?: string;      // 選んだ cam のコマンド。選べなければ無い
  configDir?: string; // 子に渡す CLAUDE_CONFIG_DIR。--default のコマンドと、選べないときは無い（ノードの env のまま）
  reason: string;     // ログに出す一言
};
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

// 選ぶ関数を返す。結果は ttl の間使い回し、同時の呼び出しは1回の cam usage にまとめる
export function camAccount(deps: AccountDeps): () => Promise<AccountChoice> {
  const now = deps.now ?? Date.now;
  const ttl = deps.ttlMs ?? 30_000;
  let cached: { at: number; p: Promise<AccountChoice> } | undefined;
  return () => {
    if (cached && now() - cached.at < ttl) return cached.p;
    const p = pick(deps).then((c) => { deps.log?.(`account: ${c.name ?? "-"} (${c.reason})`); return c; });
    cached = { at: now(), p };
    return p;
  };
}

async function pick(deps: AccountDeps): Promise<AccountChoice> {
  if (!deps.cam) return { reason: "cam not found; using the node's claude config" };
  let r: { stdout: string; code: number | null };
  try {
    r = await deps.exec([deps.cam, "usage", "--json"], deps.timeoutMs ?? 5000);
  } catch (e) {
    return { reason: `cam usage failed: ${e instanceof Error ? e.message : String(e)}; using the node's claude config` };
  }
  if (r.code !== 0) return { reason: `cam usage exited ${r.code}; using the node's claude config` };
  let v: { best?: unknown; choice?: unknown; next_available?: { name?: unknown; at?: unknown } | null };
  try {
    v = JSON.parse(r.stdout);
  } catch {
    return { reason: "cam usage did not return JSON; using the node's claude config" };
  }
  if (typeof v?.best !== "string" || !v.best) {
    const next = v?.next_available && typeof v.next_available.name === "string" && typeof v.next_available.at === "number"
      ? `, next: ${v.next_available.name} at ${new Date(v.next_available.at * 1000).toISOString()}` : "";
    return { reason: `cam has no usable account (choice: ${String(v?.choice)}${next}); using the node's claude config` };
  }
  if (!NAME.test(v.best)) return { reason: `cam returned an invalid name: ${v.best}; using the node's claude config` };
  // launcher と1字も違わないパスにする。Keychain の項目名がこのパスの sha256 で決まるので、realpath や末尾の / で変えない
  const dir = join(deps.profilesDir, v.best);
  if (await (deps.isDir ?? isDirOf)(dir)) return { name: v.best, configDir: dir, reason: `cam usage best (${String(v.choice)})` };
  return { name: v.best, reason: `cam usage best (${String(v.choice)}), a --default command; using the node's claude config` };
}

// 子に渡す環境。configDir があるときだけ CLAUDE_CONFIG_DIR を差し替える
export function withAccount<T extends Record<string, string | undefined>>(env: T, c: AccountChoice | undefined): T {
  return c?.configDir ? { ...env, CLAUDE_CONFIG_DIR: c.configDir } : env;
}

// 起動の直前の用意。選んだプロファイルに launcher と同じく `cam sync` を掛け（共有のリンクと MCP と信頼済みフォルダの同期）、
// cwd をそのプロファイルの .claude.json で信頼済みにする（#46。claude は CLAUDE_CONFIG_DIR の中の .claude.json を読む）。
// 返すのは子の環境。プロファイルを選ばなかったときは undefined（ノードの env のまま）
export type PrepareDeps = {
  pick: () => Promise<AccountChoice>;
  env: () => Record<string, string | undefined>;
  sync?: (name: string) => Promise<unknown>;
  trust?: (cwd: string, configFile: string) => Promise<unknown>;
};
export function accountPreparer(d: PrepareDeps): (cwd: string) => Promise<Record<string, string | undefined> | undefined> {
  return async (cwd) => {
    const a = await d.pick().catch(() => undefined);
    if (!a?.configDir || !a.name) return undefined;
    await d.sync?.(a.name).catch(() => {});
    await d.trust?.(cwd, join(a.configDir, ".claude.json")).catch(() => {});
    return withAccount(d.env(), a);
  };
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
