import { test, expect } from "bun:test";
import { History } from "../../src/engine/history";

test("list maps SDKSessionInfo to SessionSummary", async () => {
  const fns = {
    listSessions: async () => [{ sessionId: "h1", summary: "first prompt", lastModified: 123, customTitle: "T", firstPrompt: "from agent:lead via vm\n\nhi" }],
    getSessionMessages: async () => [],
  } as any;
  const list = await new History(fns).list();
  expect(list[0].id).toBe("h1");
  expect(list[0].title).toBe("T");
  expect(list[0].lastActivityAt).toBe(123);
  expect(list[0].capabilities).toEqual({ send: false, permissions: false, interrupt: false, stop: false, events: false });
  expect(list[0].state).toBe("exited");
  expect(list[0].kind).toBe("node");
  expect(list[0].parent).toBe("agent:lead");
});

// SDK の firstPrompt は改行が空白に潰れて届く（konaito-pro の実物の形）
test("list reads the parent from a firstPrompt whose newlines were collapsed", async () => {
  const fns = {
    listSessions: async () => [
      { sessionId: "h1", lastModified: 1, firstPrompt: "from agent:konaito-pro/29cf3311/lead via konaito-pro  親から。あなたの役割は「計測」。" },
      { sessionId: "h2", lastModified: 1, firstPrompt: "from local via konaito-pro  /goal claudetownのissue全部拾ってください" },
      { sessionId: "h3", lastModified: 1, firstPrompt: "from here via there we go" },
      { sessionId: "h4", lastModified: 1, firstPrompt: "fromage via x" },
    ],
    getSessionMessages: async () => [],
  } as any;
  const list = await new History(fns).list();
  expect(list.map((s) => s.parent)).toEqual(["agent:konaito-pro/29cf3311/lead", "local", "here", undefined]);
});

test("messages passes offset as after and returns next", async () => {
  let got: unknown;
  const fns = {
    listSessions: async () => [],
    getSessionMessages: async (id: string, o: unknown) => { got = { id, o }; return [{ type: "user", uuid: "u1", session_id: id, message: {}, parent_tool_use_id: null }]; },
    getSessionInfo: async () => undefined,
  } as any;
  const r = await new History(fns).messages("h1", 5);
  expect(got).toEqual({ id: "h1", o: { offset: 5, limit: 200 } });
  expect(r.messages.length).toBe(1);
  expect(r.next).toBe(6);
});

// jsonl の印（lastModified と fileSize）が同じなら、件数を数え直さず、末尾より後ろの messages も読まない（#23）
function fakeTranscript() {
  const st = { n: 3, mod: 100, reads: 0, infoCalls: [] as unknown[], readOpts: [] as unknown[] };
  const fns = {
    listSessions: async () => [],
    getSessionInfo: async (id: string, o?: { dir?: string }) => {
      st.infoCalls.push(o);
      if (o?.dir && o.dir !== "/w") return undefined;
      return { sessionId: id, summary: "s", lastModified: st.mod, fileSize: st.n * 10, cwd: "/w" };
    },
    getSessionMessages: async (id: string, o?: { offset?: number; limit?: number; dir?: string }) => {
      st.reads++;
      st.readOpts.push(o);
      const all = Array.from({ length: st.n }, (_, i) => ({ type: "user", uuid: `u${i}`, session_id: id, message: {}, parent_tool_use_id: null }));
      const from = o?.offset ?? 0;
      return o?.limit ? all.slice(from, from + o.limit) : all.slice(from);
    },
  } as any;
  return { st, h: new History(fns) };
}

test("count reads the transcript once while its size and mtime stay the same", async () => {
  const { st, h } = fakeTranscript();
  expect(await h.count("s1")).toBe(3);
  expect(await h.count("s1")).toBe(3);
  expect(st.reads).toBe(1);
  st.n = 5; st.mod = 200;
  expect(await h.count("s1")).toBe(5);
  expect(st.reads).toBe(2);
});

test("messages after the known end answers empty without reading, and reads again once the transcript grows", async () => {
  const { st, h } = fakeTranscript();
  expect(await h.messages("s1", 0)).toMatchObject({ next: 3 });
  expect(st.reads).toBe(1);
  expect(await h.messages("s1", 3)).toEqual({ messages: [], next: undefined });
  expect(st.reads).toBe(1);
  // 前のほうを読み直すときは読む
  expect((await h.messages("s1", 1)).messages.length).toBe(2);
  expect(st.reads).toBe(2);
  st.n = 4; st.mod = 300;
  const r = await h.messages("s1", 3);
  expect(r.messages.length).toBe(1);
  expect(r.next).toBe(4);
  expect(st.reads).toBe(3);
});

test("count and messages share the mark, so a detail poll then a messages poll read the transcript once", async () => {
  const { st, h } = fakeTranscript();
  expect(await h.count("s1")).toBe(3);
  expect(await h.messages("s1", 3)).toEqual({ messages: [], next: undefined });
  expect(st.reads).toBe(1);
});

test("the cwd learned from the first lookup is passed as dir", async () => {
  const { st, h } = fakeTranscript();
  await h.count("s1");
  expect(st.infoCalls[0]).toBeUndefined();
  expect(st.readOpts[0]).toBeUndefined();
  st.n = 4; st.mod = 2;
  await h.count("s1");
  expect(st.infoCalls[1]).toEqual({ dir: "/w" });
  expect(st.readOpts[1]).toEqual({ dir: "/w" });
});

test("without fileSize nothing is remembered and every call reads", async () => {
  let reads = 0;
  const fns = {
    listSessions: async () => [],
    getSessionInfo: async (id: string) => ({ sessionId: id, summary: "s", lastModified: 1 }),
    getSessionMessages: async () => { reads++; return []; },
  } as any;
  const h = new History(fns);
  await h.count("s1"); await h.count("s1"); await h.messages("s1", 0);
  expect(reads).toBe(3);
});
