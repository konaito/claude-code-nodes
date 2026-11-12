// 試験用の偽の PTY。argv と書かれたバイトを記録し、emit で出力を流し、exit で終わらせる
import type { PtyProc, PtySpawn } from "../../src/engine/pty-driver";

export class FakePty implements PtyProc {
  pid = 4242;
  argv: string[] = [];
  cwd = "";
  env: Record<string, string> = {};
  size = { cols: 0, rows: 0 };
  writes: string[] = [];
  resizes: Array<[number, number]> = [];
  kills: string[] = [];
  onData: (d: Uint8Array) => void = () => {};
  private done!: (c: number | null) => void;
  exited = new Promise<number | null>((r) => { this.done = r; });
  write(d: string | Uint8Array) { this.writes.push(typeof d === "string" ? d : new TextDecoder().decode(d)); }
  resize(c: number, r: number) { this.resizes.push([c, r]); }
  kill(s?: string) { this.kills.push(s ?? "SIGTERM"); this.done(null); }
  emit(s: string | Uint8Array) { this.onData(typeof s === "string" ? new TextEncoder().encode(s) : s); }
  exit(code: number | null) { this.done(code); }
}

export function fakeSpawn(): { spawn: PtySpawn; procs: FakePty[] } {
  const procs: FakePty[] = [];
  const spawn: PtySpawn = (argv, o) => {
    const p = new FakePty();
    p.argv = argv; p.cwd = o.cwd; p.env = o.env; p.size = { cols: o.cols, rows: o.rows }; p.onData = o.onData;
    procs.push(p);
    return p;
  };
  return { spawn, procs };
}
