// 試験用の SSE 読み手。app.fetch の応答から枠を読み、指定の event が来るまで待つ
export type Got = { seq: number; event: string; data: unknown };
export async function waitFor(app: { fetch(r: Request): Promise<Response> }, id: string, event: string, after: number, timeoutMs = 120000): Promise<Got> {
  const res = await app.fetch(new Request(`http://127.0.0.1/api/sessions/${id}/events?after=${after}`));
  const reader = res.body!.getReader();
  const dec = new TextDecoder();
  let buf = "";
  const deadline = Date.now() + timeoutMs;
  try {
    while (Date.now() < deadline) {
      const { value, done } = await Promise.race([reader.read(), new Promise<never>((_, rej) => setTimeout(() => rej(new Error(`timeout waiting for ${event}`)), deadline - Date.now()))]);
      if (done) throw new Error(`stream ended before ${event}`);
      buf += dec.decode(value, { stream: true });
      let i: number;
      while ((i = buf.indexOf("\n\n")) >= 0) {
        const frame = buf.slice(0, i); buf = buf.slice(i + 2);
        if (frame.startsWith(":")) continue;
        const g: Partial<Got> = {};
        for (const line of frame.split("\n")) {
          if (line.startsWith("id: ")) g.seq = Number(line.slice(4));
          else if (line.startsWith("event: ")) g.event = line.slice(7);
          else if (line.startsWith("data: ")) g.data = JSON.parse(line.slice(6));
        }
        if (g.event === event) return g as Got;
      }
    }
    throw new Error(`timeout waiting for ${event}`);
  } finally { await reader.cancel().catch(() => {}); }
}
