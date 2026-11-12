// SSE の応答。非同期イテラブルの枠をそのまま流し、切れたら購読を止める
// raw は data を JSON にした文字列（作ってあれば、もう1回 JSON にしない）
export type Frame = { id?: number | string; event: string; data?: unknown; raw?: string };

export function sse(frames: AsyncIterable<Frame>, keepAliveMs = 15000): Response {
  const enc = new TextEncoder();
  const it = frames[Symbol.asyncIterator]();
  let timer: ReturnType<typeof setInterval> | undefined;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      timer = setInterval(() => { try { controller.enqueue(enc.encode(": keep-alive\n\n")); } catch { clearInterval(timer); } }, keepAliveMs);
    },
    async pull(controller) {
      const r = await it.next();
      if (r.done) { clearInterval(timer); controller.close(); return; }
      const f = r.value;
      controller.enqueue(enc.encode(`${f.id != null ? `id: ${f.id}\n` : ""}event: ${f.event}\ndata: ${f.raw ?? JSON.stringify(f.data)}\n\n`));
    },
    cancel() { clearInterval(timer); void it.return?.(); },
  });
  return new Response(stream, { headers: { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache" } });
}
