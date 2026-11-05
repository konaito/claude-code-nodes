// 偽の query()。渡された prompt の非同期イテラブルから user 行を読み、system/init、assistant、result を順に返す
import type { Query, SDKUserMessage, PermissionResult } from "@anthropic-ai/claude-agent-sdk";
import type { QueryFn } from "../../src/engine/node-driver";

export function makeFakeQuery(opts: { permission?: boolean } = {}) {
  const received: string[] = [];
  const permissionResults: PermissionResult[] = [];
  const calls = { interrupt: 0, setPermissionMode: [] as string[] };
  let lastOptions: any;
  let die!: () => void;
  const dead = new Promise<void>((r) => (die = r));

  const queryFn = ((params: { prompt: string | AsyncIterable<SDKUserMessage>; options?: any }) => {
    const options = params.options ?? {};
    lastOptions = options;
    async function* gen() {
      yield { type: "system", subtype: "init", session_id: "fake-session", cwd: options.cwd, model: "fake-model", permissionMode: options.permissionMode ?? "default", tools: [] };
      const it = (params.prompt as AsyncIterable<SDKUserMessage>)[Symbol.asyncIterator]();
      while (true) {
        const r = await Promise.race([it.next(), dead.then(() => ({ done: true, value: undefined }) as IteratorResult<SDKUserMessage>)]);
        if (r.done) return;
        const content = r.value.message.content;
        received.push(typeof content === "string" ? content : JSON.stringify(content));
        if (opts.permission && options.canUseTool) {
          const res = await options.canUseTool("Write", { file_path: "x" }, { signal: new AbortController().signal, suggestions: [] });
          permissionResults.push(res);
        }
        yield { type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "ok" }] }, session_id: "fake-session" };
        yield { type: "result", subtype: "success", session_id: "fake-session", total_cost_usd: 0.01, usage: { input_tokens: 1, output_tokens: 1 }, is_error: false };
      }
    }
    const g = gen() as any;
    g.interrupt = async () => { calls.interrupt++; };
    g.setPermissionMode = async (m: string) => { calls.setPermissionMode.push(m); };
    return g as Query;
  }) as unknown as QueryFn;

  return { queryFn, received, permissionResults, calls, die: () => die(), get lastOptions() { return lastOptions; } };
}
