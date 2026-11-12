import { test, expect } from "bun:test";
import { bunPtySpawn, type PtyProc } from "../../src/engine/pty-driver";

// 本物の PTY（Bun.Terminal）で、resize が子に SIGWINCH として届くことを確かめる。
// 大きさ自体は term.resize だけで変わるので、stty size を読むだけでは直す前でも通る。
// そこで子には WINCH の trap の中でだけ大きさを出させる（2026-11-12、制御端末が無く SIGWINCH が届かなかった不具合）

function run(script: string): { p: PtyProc; out: () => string } {
  let buf = "";
  const p = bunPtySpawn(["/bin/sh", "-c", script], { cwd: "/", env: { PATH: "/usr/bin:/bin" }, cols: 120, rows: 40, onData: (u) => { buf += new TextDecoder().decode(u); } });
  return { p, out: () => buf.replace(/\r/g, "") };
}
async function until(out: () => string, re: RegExp, ms = 3000) {
  const end = Date.now() + ms;
  while (!re.test(out()) && Date.now() < end) await Bun.sleep(20);
  return out();
}
const LOOP = "while :; do sleep 0.05; done";

test("resize reaches the child as SIGWINCH and it reads the new size", async () => {
  const { p, out } = run(`trap 'echo WINCH $(stty size)' WINCH; echo READY $(stty size); ${LOOP}`);
  try {
    expect(await until(out, /READY/)).toContain("READY 40 120");
    p.resize(60, 20);
    expect(await until(out, /WINCH/)).toContain("WINCH 20 60");
  } finally { p.kill("SIGKILL"); await p.exited; }
});

test("resize also reaches a process the child started in the foreground", async () => {
  // claude が前面で動かす子（同じプロセスグループ）にも届く。外側の sh は WINCH を受けても何も出さない
  const inner = `trap 'echo INNER \\$(stty size)' WINCH; echo READY; ${LOOP}`;
  const { p, out } = run(`/bin/sh -c "${inner}"; echo done`);
  try {
    await until(out, /READY/);
    p.resize(70, 25);
    expect(await until(out, /INNER/)).toContain("INNER 25 70");
  } finally { p.kill("SIGKILL"); await p.exited; }
});

test("the child gets the PTY as its controlling terminal in its own session", async () => {
  const { p, out } = run(`echo TTY $(tty); ${LOOP}`);
  try {
    expect(await until(out, /TTY/)).toMatch(/TTY \/dev\/(ttys|pts\/)\S+/);
    const ps = Bun.spawnSync(["ps", "-o", "pid=,pgid=,tty=", "-p", String(p.pid)]).stdout.toString().trim().split(/\s+/);
    expect(ps[1]).toBe(String(p.pid)); // setsid されて自分がグループの頭
    expect(ps[2]).not.toMatch(/^\?+$/); // 制御端末がある（無いと ?? になる）
  } finally { p.kill("SIGKILL"); await p.exited; }
});
