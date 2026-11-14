// エージェントが立てた子のターンの終わり、承認待ち、思わぬ終わり方を、親のセッションへ知らせる
import { test, expect } from "bun:test";
import { SessionStore } from "../../src/sessions/store";
import { Sessions, type Deps } from "../../src/api/sessions";
import { BusyError } from "../../src/engine/driver";
import { idleStopReason } from "../../src/sessions/idle-stop";
import { FakeDriver } from "../helpers/fake-driver";
import type { AgentInfo } from "../../src/engine/agents";
import type { Kind, PendingPermission, SessionSummary } from "../../src/sessions/types";
import type { NotifyTiming } from "../../src/sessions/notify-parent";

const caps = { send: true, permissions: true, interrupt: true, stop: true, events: true };
const DELAY = 30;
const GAP = 400;
const P = "aaaaaaaa-0000-4000-8000-000000000001"; // 親
const C = "cccccccc-0000-4000-8000-000000000002"; // 子
const wait = (ms: number) => Bun.sleep(ms);

class S extends FakeDriver {
  parent?: string;
  title?: string;
  exitReason?: string;
  awaitingFirst = false;
  busy = 0; // send が BusyError を投げる残りの回数
  constructor(id: string, parent?: string, kind: Kind = "pty", state: SessionSummary["state"] = "running") { super({ id, capabilities: caps, kind }); this.parent = parent; this.state = state; }
  summary(): SessionSummary { return { ...super.summary(), parent: this.parent, title: this.title, exitReason: this.exitReason, ...(this.awaitingFirst ? { awaitingFirst: true } : {}) }; }
  async send(text: string) { if (this.busy > 0) { this.busy--; throw new BusyError("waiting for a permission answer"); } return super.send(text); }
  // 終わる。台帳には exited のイベントとして流れる
  exit(reason: string) { this.exitReason = reason; this.state = "exited"; this.push({ type: "exited", data: { reason } }); }
  async stop(reason = "stopped") { if (this.state !== "exited") this.exit(reason); await super.stop(); }
  turn(text = "報告") {
    this.state = "running";
    this.push({ type: "assistant", data: { type: "assistant", message: { role: "assistant", content: [{ type: "text", text }] } } });
    this.state = "idle";
    this.push({ type: "result", data: { type: "result", subtype: "success", is_error: false, result: text } });
  }
  ask(p: Partial<PendingPermission> = {}) {
    const q: PendingPermission = { requestId: `r${this.pendingList.length + 1}`, toolName: "Bash", input: { command: "rm -rf build" }, createdAt: 0, ...p };
    this.pendingList.push(q);
    this.state = "waiting_permission";
    this.push({ type: "permission_request", data: q });
    return q;
  }
}

function setup(o: { notify?: false | NotifyTiming; agents?: AgentInfo[]; terminals?: Map<string, S> } = {}) {
  const store = new SessionStore();
  const sessions = new Sessions({
    nodeName: "vm", roots: ["/tmp"], lobby: "/tmp/lobby", store,
    agents: async () => o.agents ?? [],
    terminalFor: (a: AgentInfo) => o.terminals!.get(a.sessionId!)!,
    history: { list: async () => [], count: async () => 0, get: async () => undefined, messages: async () => ({ messages: [] }) },
    notifyParent: o.notify === undefined ? { delayMs: DELAY, minGapMs: GAP, retryMs: DELAY } : o.notify,
  } as unknown as Deps);
  const parent = new S(P, "local", "pty", "idle");
  const child = new S(C, `agent:vm/${P.slice(0, 8)}/lead`, "node");
  child.title = "ct-order-drop";
  return { store, sessions, parent, child };
}

test("a child's turn end reaches its parent as one short message with a ccn from line and a cursor that reads the report", async () => {
  const { store, sessions, parent, child } = setup();
  store.add(parent); store.add(child);
  child.turn("できた");
  await wait(DELAY / 2);
  expect(parent.sent).toEqual([]); // 後ろ寄せで少し待つ
  await wait(DELAY * 2);
  expect(parent.sent.length).toBe(1);
  const [from, , body] = parent.sent[0]!.split("\n");
  expect(from).toBe("from ccn:vm/cccccccc via vm");
  expect(from!.startsWith("from agent:")).toBe(false);
  expect(body).toBe(`[ccn] 子 ct-order-drop（cccccccc）のターンが終わった。read_messages peer=vm session=${C} after=0 で読んで（読み済みなら返事は不要）`);
  const after = Number(/after=(\d+)/.exec(body!)![1]);
  const page = await sessions.messages(C, after);
  expect((page.messages as Array<{ type: string }>).map((m) => m.type)).toEqual(["assistant", "result"]);
});

test("turns close together are merged into one message, and the next one waits for the gap and starts after the last notified result", async () => {
  const { store, parent, child } = setup();
  store.add(parent); store.add(child);
  child.turn("1"); child.turn("2");
  await wait(DELAY * 3);
  expect(parent.sent.length).toBe(1);
  expect(parent.sent[0]).toContain("（2回分）");
  child.turn("3");
  await wait(DELAY * 3);
  expect(parent.sent.length).toBe(1); // 間隔の下限の間は送らない
  await wait(GAP);
  expect(parent.sent.length).toBe(2);
  expect(parent.sent[1]).toContain("after=4"); // 前の知らせの result（seq 4）より後
  expect(parent.sent[1]).not.toContain("回分");
});

test("a pending permission is sent with the tool, a one-line description and answer_permission; answered before sending, nothing is sent", async () => {
  const { store, parent, child } = setup();
  store.add(parent); store.add(child);
  child.ask({ description: "消す\nビルドの\t出力" });
  await wait(DELAY * 3);
  expect(parent.sent.length).toBe(1);
  expect(parent.sent[0]).toContain(`が承認を待っている: Bash 消す ビルドの 出力。answer_permission peer=vm session=${C} request_id=r1 で答えて`);

  const b = setup();
  b.store.add(b.parent); b.store.add(b.child);
  const q = b.child.ask();
  await b.child.answer(q.requestId, { behavior: "allow" });
  b.child.state = "running";
  await wait(DELAY * 3);
  expect(b.parent.sent).toEqual([]);
});

test("a turn that went back to work before sending is dropped", async () => {
  const { store, parent, child } = setup();
  store.add(parent); store.add(child);
  child.turn();
  child.state = "running"; // 親がすぐ次を送った
  await wait(DELAY * 3);
  expect(parent.sent).toEqual([]);
});

test("an unexpected exit is sent; idle-stop and stops through the API are not", async () => {
  const a = setup();
  a.store.add(a.parent); a.store.add(a.child);
  a.child.exit("exit 1");
  await wait(DELAY * 3);
  expect(a.parent.sent.length).toBe(1);
  expect(a.parent.sent[0]).toContain(`が終わった: exit 1。会話は create_session peer=vm resume=${C} で続けられる`);

  const b = setup();
  b.store.add(b.parent); b.store.add(b.child);
  b.child.exit(idleStopReason(600_000, C));
  await wait(DELAY * 3);
  expect(b.parent.sent).toEqual([]);

  const c = setup();
  c.store.add(c.parent); c.store.add(c.child);
  await c.sessions.remove(C);
  await wait(DELAY * 3);
  expect(c.parent.sent).toEqual([]);
});

test("no endless back and forth: the parent's own turn ends are not sent to the child, and a cycle made by resume is refused", async () => {
  const { store, parent, child } = setup();
  store.add(parent); store.add(child);
  // 親が子に返事を送る → 子のターンが終わる → 親に知らせる → 親のターンが終わる（親の親は人なので、どこにも送らない）
  await child.send("from agent:vm/aaaaaaaa/lead via vm\n\n続けて");
  child.turn();
  await wait(DELAY * 3);
  expect(parent.sent.length).toBe(1);
  parent.turn("読んだ");
  await wait(GAP + DELAY * 3);
  expect(child.sent.length).toBe(1); // 親が送った1通だけ
  expect(parent.sent.length).toBe(1);

  // 子が止まった親を resume すると、親の parent が子になる。その形では子の知らせも親の知らせも送らない
  const r = setup();
  r.parent.parent = `agent:vm/${C.slice(0, 8)}/lead`;
  r.store.add(r.parent); r.store.add(r.child);
  r.child.turn(); r.parent.turn();
  await wait(DELAY * 3);
  expect(r.parent.sent).toEqual([]);
  expect(r.child.sent).toEqual([]);
});

test("not sent when the parent is missing, exited, on another node, the lobby, or still waiting for its first message", async () => {
  const cases: Array<(x: ReturnType<typeof setup>) => void> = [
    (x) => { x.store.add(x.child); },                                                        // 親がいない
    (x) => { x.parent.state = "exited"; x.store.add(x.parent); x.store.add(x.child); },      // 親が終わっている
    (x) => { x.child.parent = `agent:pro/${P.slice(0, 8)}/lead`; x.store.add(x.parent); x.store.add(x.child); }, // ほかのノード
    (x) => { x.child.parent = `agent:vm/${P.slice(0, 8)}/lobby`; x.store.add(x.parent); x.store.add(x.child); }, // 受け口（依頼主は人）
    (x) => { x.parent.awaitingFirst = true; x.store.add(x.parent); x.store.add(x.child); },  // 1通目を待っている
    (x) => { x.child.parent = "local"; x.store.add(x.parent); x.store.add(x.child); },       // 人が立てた
  ];
  for (const f of cases) {
    const x = setup();
    f(x);
    x.child.turn();
    await wait(DELAY * 3);
    expect(x.parent.sent).toEqual([]);
  }
});

test("a child started by the lobby notifies the lobby's requester, even after the lobby was stopped", async () => {
  const L = "bbbbbbbb-0000-4000-8000-000000000003";
  const x = setup();
  const lobby = new S(L, `agent:vm/${P.slice(0, 8)}/meta`, "node", "idle");
  x.child.parent = `agent:vm/${L.slice(0, 8)}/lobby`;
  x.store.add(x.parent); x.store.add(lobby); x.store.add(x.child);
  lobby.exit(idleStopReason(600_000, L));
  x.child.turn();
  await wait(DELAY * 3);
  expect(lobby.sent).toEqual([]);
  expect(x.parent.sent.length).toBe(1);
  expect(x.parent.sent[0]).toContain("子 ct-order-drop（cccccccc）のターンが終わった");
});

test("a terminal session started by a person can be the parent", async () => {
  const term = new S(P, undefined, "terminal", "running");
  const x = setup({ agents: [{ pid: 9, cwd: "/tmp", kind: "interactive", startedAt: 0, sessionId: P, status: "busy" }], terminals: new Map([[P, term]]) });
  x.store.add(x.child);
  x.child.turn();
  await wait(DELAY * 3);
  expect(term.sent.length).toBe(1);
  expect(term.sent[0]).toContain("ターンが終わった");
});

test("a pty parent that is waiting for a permission gets the message later", async () => {
  const { store, parent, child } = setup();
  parent.busy = 2;
  store.add(parent); store.add(child);
  child.turn();
  await wait(DELAY * 2);
  expect(parent.sent).toEqual([]);
  await wait(DELAY * 4);
  expect(parent.sent.length).toBe(1);
});

test("notifyParent: false turns it off, and a stopping node sends nothing", async () => {
  const a = setup({ notify: false });
  a.store.add(a.parent); a.store.add(a.child);
  a.child.turn();
  await wait(DELAY * 3);
  expect(a.parent.sent).toEqual([]);

  const b = setup();
  b.store.add(b.parent); b.store.add(b.child);
  b.store.quiet();
  b.child.exit("stopped");
  await wait(DELAY * 3);
  expect(b.parent.sent).toEqual([]);
});
