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

test("messages passes offset as after and returns next", async () => {
  let got: unknown;
  const fns = {
    listSessions: async () => [],
    getSessionMessages: async (id: string, o: unknown) => { got = { id, o }; return [{ type: "user", uuid: "u1", session_id: id, message: {}, parent_tool_use_id: null }]; },
  } as any;
  const r = await new History(fns).messages("h1", 5);
  expect(got).toEqual({ id: "h1", o: { offset: 5, limit: 200 } });
  expect(r.messages.length).toBe(1);
  expect(r.next).toBe(6);
});
