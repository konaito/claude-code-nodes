import { test, expect } from "bun:test";
import { accountPreparer, bunExec, camAccount, withAccount, type Exec } from "../../src/engine/account";

const usage = (v: unknown): Exec => async () => ({ stdout: JSON.stringify(v), code: 0 });
const dirs = (...ds: string[]) => async (p: string) => ds.includes(p);

test("cam usage の best のプロファイルを CLAUDE_CONFIG_DIR にする。パスは launcher と同じ形のまま", async () => {
  const pick = camAccount({ cam: "/c/cam", profilesDir: "/h/.cam/profiles", exec: usage({ best: "shared", choice: "normal" }), isDir: dirs("/h/.cam/profiles/shared") });
  const a = await pick();
  expect(a).toMatchObject({ name: "shared", configDir: "/h/.cam/profiles/shared" });
  expect(withAccount({ PATH: "/bin", CLAUDE_CONFIG_DIR: "/old" }, a)).toEqual({ PATH: "/bin", CLAUDE_CONFIG_DIR: "/h/.cam/profiles/shared" });
});

test("プロファイルの無い --default のコマンドは env を触らない", async () => {
  const pick = camAccount({ cam: "/c/cam", profilesDir: "/h/.cam/profiles", exec: usage({ best: "main", choice: "normal" }), isDir: dirs() });
  const a = await pick();
  expect(a.name).toBe("main");
  expect(a.configDir).toBeUndefined();
  const env = { PATH: "/bin" };
  expect(withAccount(env, a)).toBe(env);
});

test("選べないときは env を触らず、理由を返す（cam が無い、落ちる、止まる、JSON でない、best が null、名前がおかしい）", async () => {
  const base = { profilesDir: "/p", isDir: dirs("/p/x") };
  const cases: [Parameters<typeof camAccount>[0], RegExp][] = [
    [{ ...base, cam: undefined, exec: usage({ best: "x" }) }, /cam not found/],
    [{ ...base, cam: "/c", exec: async () => ({ stdout: "", code: 1 }) }, /exited 1/],
    [{ ...base, cam: "/c", exec: async () => { throw new Error("timed out after 5000ms"); } }, /timed out/],
    [{ ...base, cam: "/c", exec: async () => ({ stdout: "oops", code: 0 }) }, /JSON/],
    [{ ...base, cam: "/c", exec: usage({ best: null, choice: "none", next_available: { name: "coo", at: 1794832199 } }) }, /no usable account \(choice: none, next: coo at /],
    [{ ...base, cam: "/c", exec: usage({ best: "../etc" }) }, /invalid name/],
  ];
  for (const [deps, re] of cases) {
    const a = await camAccount(deps)();
    expect(a.configDir).toBeUndefined();
    expect(a.reason).toMatch(re);
  }
});

test("結果は ttl の間使い回し、同時の呼び出しは1回にまとめる。ttl を過ぎたら取り直す", async () => {
  let n = 0;
  let t = 0;
  const exec: Exec = async () => { n++; await Bun.sleep(5); return { stdout: JSON.stringify({ best: n === 1 ? "a" : "b" }), code: 0 }; };
  const logs: string[] = [];
  const pick = camAccount({ cam: "/c", profilesDir: "/p", exec, isDir: dirs("/p/a", "/p/b"), now: () => t, ttlMs: 1000, log: (m) => logs.push(m) });
  const [x, y] = await Promise.all([pick(), pick()]);
  expect(n).toBe(1);
  expect(x.name).toBe("a");
  expect(y.name).toBe("a");
  t = 999;
  expect((await pick()).name).toBe("a");
  t = 1000;
  expect((await pick()).name).toBe("b");
  expect(n).toBe(2);
  expect(logs).toEqual(["account: a (cam usage best (undefined))", "account: b (cam usage best (undefined))"]);
});

test("用意は、選んだプロファイルに sync を掛け、そのプロファイルの .claude.json で cwd を信頼してから環境を返す", async () => {
  const order: string[] = [];
  const prepare = accountPreparer({
    pick: async () => ({ name: "shared", configDir: "/h/.cam/profiles/shared", reason: "" }),
    env: () => ({ PATH: "/bin" }),
    sync: async (n) => { order.push(`sync ${n}`); },
    trust: async (cwd, f) => { order.push(`trust ${cwd} ${f}`); },
  });
  expect(await prepare("/w")).toEqual({ PATH: "/bin", CLAUDE_CONFIG_DIR: "/h/.cam/profiles/shared" });
  expect(order).toEqual(["sync shared", "trust /w /h/.cam/profiles/shared/.claude.json"]);
});

test("用意は、プロファイルを選ばなかったら何もせず undefined を返す。sync と trust が落ちても環境は返す", async () => {
  const touched: string[] = [];
  const none = accountPreparer({ pick: async () => ({ reason: "cam not found" }), env: () => ({}), sync: async () => { touched.push("sync"); }, trust: async () => { touched.push("trust"); } });
  expect(await none("/w")).toBeUndefined();
  const broken = accountPreparer({ pick: async () => { throw new Error("x"); }, env: () => ({}) });
  expect(await broken("/w")).toBeUndefined();
  expect(touched).toEqual([]);
  const failing = accountPreparer({
    pick: async () => ({ name: "a", configDir: "/p/a", reason: "" }), env: () => ({}),
    sync: async () => { throw new Error("sync"); }, trust: async () => { throw new Error("trust"); },
  });
  expect(await failing("/w")).toEqual({ CLAUDE_CONFIG_DIR: "/p/a" });
});

test("bunExec は上限時間を過ぎたら止めて投げる", async () => {
  const t0 = Date.now();
  await expect(bunExec(["sleep", "5"], 100)).rejects.toThrow(/timed out/);
  expect(Date.now() - t0).toBeLessThan(2000);
  expect(await bunExec(["echo", "hi"], 2000)).toEqual({ stdout: "hi\n", code: 0 });
});
