// ヘッドレスの端末。PTY の出力を流し続け、画面を繋いだときに今の画面（文字、代替画面、カーソル、モード）を文字列で返す。
// claude は代替画面で変わったセルだけを描くので、末尾のバイト列を流すだけでは枠線などが欠ける（Claude Town の docs/research/pty-measure.md、2026-11-12）
import { Terminal } from "@xterm/headless";
import { SerializeAddon } from "@xterm/addon-serialize";

export class Screen {
  private term: Terminal;
  private ser = new SerializeAddon();

  constructor(cols: number, rows: number, scrollback = 200) {
    this.term = new Terminal({ cols, rows, scrollback, allowProposedApi: true });
    this.term.loadAddon(this.ser);
  }
  write(d: Uint8Array) { this.term.write(d); }
  resize(cols: number, rows: number) { this.term.resize(cols, rows); }
  // 書いたものが全部反映されるのを待ってから取る
  async snapshot(): Promise<string> {
    await new Promise<void>((r) => this.term.write(new Uint8Array(0), () => r()));
    return this.ser.serialize();
  }
  dispose() { this.term.dispose(); }
}
