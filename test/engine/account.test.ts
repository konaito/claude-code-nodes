import { test, expect } from "bun:test";
import { accountFromPs, accountPreparer, bunExec, camAccount, pidAccount, withAccount, type Exec } from "../../src/engine/account";

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
  expect(await prepare("/w")).toEqual({ env: { PATH: "/bin", CLAUDE_CONFIG_DIR: "/h/.cam/profiles/shared" }, account: "shared" });
  expect(order).toEqual(["sync shared", "trust /w /h/.cam/profiles/shared/.claude.json"]);
});

test("用意は、選べなかったら何もせず、環境もアカウントも返さない。sync と trust が落ちても環境は返す", async () => {
  const touched: string[] = [];
  const none = accountPreparer({ pick: async () => ({ reason: "cam not found" }), env: () => ({}), sync: async () => { touched.push("sync"); }, trust: async () => { touched.push("trust"); } });
  expect(await none("/w")).toEqual({});
  const broken = accountPreparer({ pick: async () => { throw new Error("x"); }, env: () => ({}) });
  expect(await broken("/w")).toEqual({});
  expect(touched).toEqual([]);
  const failing = accountPreparer({
    pick: async () => ({ name: "a", configDir: "/p/a", reason: "" }), env: () => ({}),
    sync: async () => { throw new Error("sync"); }, trust: async () => { throw new Error("trust"); },
  });
  expect(await failing("/w")).toEqual({ env: { CLAUDE_CONFIG_DIR: "/p/a" }, account: "a" });
});

test("用意は、--default のコマンドでは環境を触らず sync もしないが、アカウントと email は返す", async () => {
  const touched: string[] = [];
  const prepare = accountPreparer({ pick: async () => ({ name: "main", email: "main@example.com", reason: "" }), env: () => ({ PATH: "/bin" }), sync: async () => { touched.push("sync"); }, trust: async () => { touched.push("trust"); } });
  expect(await prepare("/w")).toEqual({ account: "main", accountEmail: "main@example.com" });
  expect(touched).toEqual([]);
});

test("email は cam usage の accounts から読む。選んだコマンドの email を返し、emailOf はほかの名前も引ける", async () => {
  const pick = camAccount({
    cam: "/c", profilesDir: "/p", isDir: dirs("/p/a"),
    exec: usage({ best: "a", choice: "normal", accounts: [{ name: "a", email: "a@example.com" }, { name: "b", email: "b@example.com" }, { name: "../x", email: "x@example.com" }, { name: "c" }] }),
  });
  expect(pick.emailOf("b")).toBeUndefined(); // まだ読んでいない
  expect(await pick()).toMatchObject({ name: "a", email: "a@example.com", configDir: "/p/a" });
  expect(pick.emailOf("b")).toBe("b@example.com");
  expect(pick.emailOf("c")).toBeUndefined();
  expect(pick.emailOf("../x")).toBeUndefined();
});

test("枠の残るコマンドが無い（choice: none）ときは none を返し、次に戻る時刻はミリ秒にする。判定できないだけのときは none を付けない", async () => {
  const at = 1794832199;
  const none = await camAccount({ cam: "/c", profilesDir: "/p", exec: usage({ best: null, choice: "none", next_available: { name: "b", at } }) })();
  expect(none.none).toEqual({ nextAvailable: { account: "b", at: at * 1000 } });
  expect(none.name).toBeUndefined();
  const unknownNext = await camAccount({ cam: "/c", profilesDir: "/p", exec: usage({ best: null, choice: "none", next_available: null }) })();
  expect(unknownNext.none).toEqual({ nextAvailable: null });
  const undecided = await camAccount({ cam: "/c", profilesDir: "/p", exec: usage({ best: null, choice: "unknown" }) })();
  expect(undecided.none).toBeUndefined();
  const missing = await camAccount({ cam: undefined, profilesDir: "/p", exec: usage({}) })();
  expect(missing.none).toBeUndefined();
});

test("fresh は ttl の中でも cam usage を取り直し、取り直した結果を次の呼び出しが使い回す。走っている最中の呼び出しは1回にまとめる", async () => {
  let n = 0;
  const exec: Exec = async () => { n++; await Bun.sleep(5); return { stdout: JSON.stringify({ best: `a${n}` }), code: 0 }; };
  const pick = camAccount({ cam: "/c", profilesDir: "/p", exec, isDir: async () => true, now: () => 0, ttlMs: 1000 });
  expect((await pick()).name).toBe("a1");
  expect((await pick()).name).toBe("a1");
  expect((await pick({ fresh: true })).name).toBe("a2");
  expect((await pick()).name).toBe("a2");
  const [x, y] = await Promise.all([pick({ fresh: true }), pick({ fresh: true })]);
  expect([x.name, y.name]).toEqual(["a3", "a3"]);
  expect(n).toBe(3);
});

test("端末のセッションのアカウントは、ps の環境の CLAUDE_CONFIG_DIR がプロファイルの下のときだけ読む。引数の中の文字列には当たらない", () => {
  const P = "/h/.cam/profiles";
  const argv = "claude --resume 1234";
  expect(accountFromPs(`${argv}\n`, `${argv} PATH=/bin CLAUDE_CONFIG_DIR=${P}/coo HOME=/h\n`, P)).toBe("coo");
  expect(accountFromPs(argv, `${argv} PATH=/bin HOME=/h`, P)).toBeUndefined();                         // 既定の設定
  expect(accountFromPs(argv, `${argv} CLAUDE_CONFIG_DIR=/elsewhere/coo`, P)).toBeUndefined();          // プロファイルの外
  expect(accountFromPs(argv, `${argv} CLAUDE_CONFIG_DIR=${P}/../x`, P)).toBeUndefined();               // 名前の形でない
  expect(accountFromPs(argv, `${argv} CLAUDE_CONFIG_DIR=${P}/coo/sub`, P)).toBeUndefined();
  // 最初の文を引数で受けた claude。文の中の CLAUDE_CONFIG_DIR= は引数なので読まない
  const withPrompt = `claude --session-id x 説明 CLAUDE_CONFIG_DIR=${P}/ceo を渡す`;
  expect(accountFromPs(withPrompt, `${withPrompt} PATH=/bin CLAUDE_CONFIG_DIR=${P}/coo`, P)).toBe("coo");
  expect(accountFromPs(withPrompt, `${withPrompt} PATH=/bin`, P)).toBeUndefined();
  // 2つの出力が食い違う（間にプロセスが替わったなど）ときは読まない
  expect(accountFromPs("claude a", `claude b CLAUDE_CONFIG_DIR=${P}/coo`, P)).toBeUndefined();
  expect(accountFromPs("", ` CLAUDE_CONFIG_DIR=${P}/coo`, P)).toBeUndefined();
});

test("pidAccount は pid と起動時刻ごとに1回だけ ps を呼び、email は emailOf で足す。ps が落ちたら載せない", async () => {
  const P = "/h/.cam/profiles";
  const calls: string[][] = [];
  const run = async (argv: string[]) => {
    calls.push(argv);
    if (argv.at(-1) === "9") throw new Error("no ps");
    const base = "claude";
    return { stdout: argv[1] === "eww" ? `${base} CLAUDE_CONFIG_DIR=${P}/coo\n` : `${base}\n`, code: 0 };
  };
  const emails = new Map<string, string>();
  const of = pidAccount({ profilesDir: P, run, emailOf: (n) => emails.get(n) });
  expect(await of(7, 100)).toEqual({ account: "coo" });
  emails.set("coo", "coo@example.com");
  expect(await of(7, 100)).toEqual({ account: "coo", accountEmail: "coo@example.com" });
  expect(calls.length).toBe(2); // ps ww と ps eww を1回ずつ
  expect(calls.map((c) => c.slice(0, 2))).toEqual([["ps", "ww"], ["ps", "eww"]]);
  await of(7, 200); // 同じ pid でも起動時刻が違えば別のプロセス
  expect(calls.length).toBe(4);
  expect(await of(9, 1)).toBeUndefined();
  expect(await of(undefined)).toBeUndefined();
  expect(await of(0)).toBeUndefined();
});

test("bunExec は上限時間を過ぎたら止めて投げる", async () => {
  const t0 = Date.now();
  await expect(bunExec(["sleep", "5"], 100)).rejects.toThrow(/timed out/);
  expect(Date.now() - t0).toBeLessThan(2000);
  expect(await bunExec(["echo", "hi"], 2000)).toEqual({ stdout: "hi\n", code: 0 });
});
