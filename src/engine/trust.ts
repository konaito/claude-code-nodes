// ノードが claude を起動する前に、起動先のディレクトリを claude の設定（.claude.json）で信頼済みにする。
// 信頼の記録が無いと、対話の claude は「Accessing workspace / Quick safety check」の確認画面で止まり、子が入力待ちのまま動かない（#46）。
// 信頼は git のルートに付き、親のディレクトリの信頼は入れ子の git リポジトリに及ばない（公式の permissions の説明）。そこで cwd と git のルートの両方に書く。
// 項目の形（projects[<実体のパス>].hasTrustDialogAccepted）は公開の仕様ではない。2.1.323 で、{ hasTrustDialogAccepted: true } だけの項目で確認画面が出ないことを実測した。
// claude 本体も同じファイルを書く。claude は <file>.lock をディレクトリで作ってから一時ファイル→rename で書く（2.1.323 で観測）。こちらも同じロックを取る
import { chmod, mkdir, readFile, realpath, rename, rmdir, stat, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { Runner } from "./agents";

// claude が読む設定ファイル。CLAUDE_CONFIG_DIR があればその中の .claude.json、無ければホームの .claude.json
export const claudeConfigFile = (env: Record<string, string | undefined>, home: string): string =>
  env.CLAUDE_CONFIG_DIR ? join(env.CLAUDE_CONFIG_DIR, ".claude.json") : join(home, ".claude.json");

// cwd を含む git リポジトリのルート（実体のパス）。git でなければ undefined
export const gitRootOf = (run: Runner) => async (cwd: string): Promise<string | undefined> => {
  const r = await run(["git", "-C", cwd, "rev-parse", "--show-toplevel"]).catch(() => ({ stdout: "", code: 1 }));
  const top = r.code === 0 ? r.stdout.trim() : "";
  return top ? realpath(top).catch(() => top) : undefined;
};

export type TrustOptions = {
  configFile: string;
  gitRoot?: (cwd: string) => Promise<string | undefined>;
  log?: (msg: string) => void;
  lockWaitMs?: number;  // ロックが空くのを待つ上限。過ぎたら書かない。既定 3 秒
  lockStaleMs?: number; // これより古いロックは、落ちた claude が残したものとみなして外す。既定 30 秒
  retries?: number;     // 読んでから rename までにファイルが変わったときに読み直す回数。既定 3
};
export type TrustResult = { written: string[] } | { already: string[] } | { skipped: string };

type Project = Record<string, unknown>;
type Config = Record<string, unknown> & { projects?: Record<string, Project> };

const untrusted = (c: Config, dirs: string[]) => dirs.filter((d) => c.projects?.[d]?.hasTrustDialogAccepted !== true);
const sameFile = (a: { mtimeMs: number; size: number }, b: { mtimeMs: number; size: number }) => a.mtimeMs === b.mtimeMs && a.size === b.size;

// 読み出しが空でなく、JSON のオブジェクトとして読めたときだけ返す
async function readConfig(file: string): Promise<{ raw: string; config: Config } | { error: string }> {
  const raw = await readFile(file, "utf8").catch((e: Error) => ({ error: e.message }));
  if (typeof raw !== "string") return raw;
  if (!raw.trim()) return { error: "empty" };
  try {
    const v = JSON.parse(raw) as unknown;
    if (!v || typeof v !== "object" || Array.isArray(v)) return { error: "not a JSON object" };
    const projects = (v as Config).projects;
    if (projects !== undefined && (!projects || typeof projects !== "object" || Array.isArray(projects))) return { error: "projects is not an object" };
    return { raw, config: v as Config };
  } catch (e) {
    return { error: `invalid JSON: ${(e as Error).message}` };
  }
}

// claude と同じロック（<file>.lock のディレクトリ）を取る。取れなければ undefined
async function lock(file: string, waitMs: number, staleMs: number): Promise<(() => Promise<void>) | undefined> {
  const dir = `${file}.lock`;
  const until = Date.now() + waitMs;
  for (;;) {
    try {
      await mkdir(dir);
      return () => rmdir(dir).catch(() => {});
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") return undefined;
    }
    const st = await stat(dir).catch(() => undefined);
    if (st && Date.now() - st.mtimeMs > staleMs) { await rmdir(dir).catch(() => {}); continue; }
    if (Date.now() >= until) return undefined;
    await Bun.sleep(50);
  }
}

// 同じノードの中の書き込みは1本ずつにする（同時の create が互いの書き込みを消さないように）
const queues = new Map<string, Promise<unknown>>();
function serial<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const run = (queues.get(key) ?? Promise.resolve()).then(fn, fn);
  queues.set(key, run.catch(() => {}));
  return run;
}

// cwd（と git のルート）を信頼済みにする。失敗しても投げない（起動は続ける）。書けなかった理由は log に出す
export async function trustDir(cwd: string, o: TrustOptions): Promise<TrustResult> {
  const log = o.log ?? ((m: string) => console.error(m));
  try {
    const root = await o.gitRoot?.(cwd).catch(() => undefined);
    const dirs = [...new Set([cwd, ...(root ? [root] : [])])];
    // symlink なら実体に書く（rename で symlink を普通のファイルに変えない）
    const file = await realpath(o.configFile).catch(() => undefined);
    if (!file) { log(`trust: ${o.configFile} が無いので書かない（${cwd}）`); return { skipped: "config not found" }; }
    // ほとんどの起動は既に信頼済みなので、ロックを取らずに先に見る
    const first = await readConfig(file);
    if ("error" in first) { log(`trust: ${file} を読めないので書かない（${first.error}、${cwd}）`); return { skipped: first.error }; }
    if (!untrusted(first.config, dirs).length) return { already: dirs };
    return await serial(file, () => write(file, dirs, cwd, o, log));
  } catch (e) {
    log(`trust: ${cwd} を信頼済みにできなかった（${(e as Error).message}）`);
    return { skipped: (e as Error).message };
  }
}

async function write(file: string, dirs: string[], cwd: string, o: TrustOptions, log: (m: string) => void): Promise<TrustResult> {
  const unlock = await lock(file, o.lockWaitMs ?? 3000, o.lockStaleMs ?? 30_000);
  if (!unlock) { log(`trust: ${file}.lock が空かないので書かない（${cwd}）`); return { skipped: "locked" }; }
  try {
    for (let i = 0; i <= (o.retries ?? 3); i++) {
      const before = await stat(file);
      const r = await readConfig(file);
      if ("error" in r) { log(`trust: ${file} を読めないので書かない（${r.error}、${cwd}）`); return { skipped: r.error }; }
      const todo = untrusted(r.config, dirs);
      if (!todo.length) return { already: dirs };
      // 他のキーはそのまま、足りない dir の hasTrustDialogAccepted だけを true にする
      const projects = { ...(r.config.projects ?? {}) };
      for (const d of todo) projects[d] = { ...(projects[d] ?? {}), hasTrustDialogAccepted: true };
      // claude と同じ整形（2文字の字下げ）。2.1.323 の実ファイルで、読んで書き戻すと元と一致することを確かめた
      const out = JSON.stringify({ ...r.config, projects }, null, 2);
      const tmp = join(dirname(file), `.claude.json.ccn-trust.${process.pid}.${crypto.randomUUID().slice(0, 8)}`);
      await writeFile(tmp, out, { mode: before.mode & 0o777 });
      // 読んだ後に claude がロックを取らずに書いていたら、捨てて読み直す
      const now = await stat(file);
      if (!sameFile(before, now)) { await unlink(tmp).catch(() => {}); continue; }
      // 上書きする前の1個を控えに残す（読み書きで壊したときの戻し先）。控えは 0600
      const bak = `${file}.ccn-trust.bak`;
      await writeFile(bak, r.raw, { mode: 0o600 }).then(() => chmod(bak, 0o600)).catch(() => {});
      await rename(tmp, file);
      // 書いた後に読み直して確かめる。claude が古い中身で上書きしていたら、次の起動でまた書く
      const after = await readConfig(file);
      const lost = "error" in after ? todo : untrusted(after.config, todo);
      log(lost.length ? `trust: ${file} に書いたが ${lost.join(", ")} が残っていない` : `trust: ${todo.join(", ")} を信頼済みにした（${file}）`);
      return { written: todo };
    }
    log(`trust: ${file} が書いている間に変わり続けたので書かない（${cwd}）`);
    return { skipped: "changed while writing" };
  } finally {
    await unlock();
  }
}
