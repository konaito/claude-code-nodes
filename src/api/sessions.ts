// セッションの監視と管理の処理。台帳（生きているもの）、agents（端末）、履歴（過去）を合成し、能力で振る舞いを決める
import { resolve, sep } from "node:path";
import { stat } from "node:fs/promises";
import type { Driver } from "../engine/driver";
import type { AgentInfo } from "../engine/agents";
import type { StartOptions } from "../engine/node-driver";
import type { History } from "../engine/history";
import type { SessionStore } from "../sessions/store";
import type { PermissionAnswer, SessionSummary } from "../sessions/types";
import type { Identity, Caller } from "../identity/identity";
import { withFromLine } from "../identity/from-line";
import { HttpError } from "./errors";
import { sse } from "./sse";

export type HostInfo = { claudeVersion: string; account?: string; rateLimit?: unknown; load: number[] };
export type Deps = {
  nodeName: string;
  roots: string[];
  store: SessionStore;
  identity: Identity;
  history: History;
  startNode: (opts: StartOptions, caller: Caller) => Promise<Driver>;
  agents: () => Promise<AgentInfo[]>;
  terminalFor: (a: AgentInfo) => Driver;
  host: () => Promise<HostInfo>;
};

const underRoot = (cwd: string, roots: string[]) => roots.some((r) => { const root = resolve(r); return cwd === root || cwd.startsWith(root + sep); });

export class Sessions {
  constructor(private d: Deps) {}

  async host() {
    const h = await this.d.host();
    return { name: this.d.nodeName, roots: this.d.roots, ...h };
  }
  async list(parent: string | null): Promise<SessionSummary[]> {
    const live = this.d.store.list();
    const seen = new Set(live.map((s) => s.id));
    const terms = (await this.d.agents()).filter((a) => a.sessionId && !seen.has(a.sessionId)).map((a) => this.d.terminalFor(a).summary());
    for (const t of terms) seen.add(t.id);
    const past = (await this.d.history.list()).filter((h) => !seen.has(h.id));
    const all = [...live, ...terms, ...past];
    return parent ? all.filter((s) => s.parent === parent) : all;
  }
  async create(req: Request) {
    const body = (await req.json().catch(() => ({}))) as Partial<StartOptions> & { cwd?: unknown };
    if (typeof body.cwd !== "string" || !body.cwd) throw new HttpError(400, { error: "cwd is required" });
    const cwd = resolve(body.cwd);
    if (!underRoot(cwd, this.d.roots)) throw new HttpError(400, { error: "cwd is outside roots", roots: this.d.roots });
    const st = await stat(cwd).catch(() => null);
    if (!st?.isDirectory()) throw new HttpError(400, { error: "cwd does not exist" });
    if (!body.prompt && !body.resume) throw new HttpError(400, { error: "prompt or resume is required" });
    const caller = this.d.identity.callerOf(req);
    const opts: StartOptions = { ...body, cwd, prompt: body.prompt ? withFromLine(caller, this.d.nodeName, body.prompt) : undefined } as StartOptions;
    const driver = await this.d.startNode(opts, caller);
    this.d.store.add(driver);
    return { id: driver.id };
  }
  async detail(id: string) {
    const driver = await this.find(id);
    if (driver) return { ...driver.summary(), pending: driver.pending() };
    const past = (await this.d.history.list()).find((h) => h.id === id);
    if (past) return { ...past, pending: [] };
    throw new HttpError(404, { error: "unknown session" });
  }
  async messages(id: string, after: number) {
    if (this.d.store.get(id)) {
      const events = this.d.store.eventsSince(id, after);
      return { messages: events, next: events.length ? events[events.length - 1]!.seq : undefined };
    }
    return this.d.history.messages(id, after);
  }
  async send(id: string, req: Request) {
    const driver = await this.must(id);
    if (driver.summary().state === "exited") throw new HttpError(409, { error: "session exited", hint: "resume" });
    const body = (await req.json().catch(() => ({}))) as { text?: unknown };
    if (typeof body.text !== "string" || !body.text.trim()) throw new HttpError(400, { error: "text is required" });
    const caller = this.d.identity.callerOf(req);
    return driver.send(withFromLine(caller, this.d.nodeName, body.text));
  }
  async answer(id: string, requestId: string, req: Request) {
    const driver = await this.must(id);
    if (!driver.capabilities.permissions) throw new HttpError(409, { error: "capability permissions not available" });
    const body = (await req.json().catch(() => ({}))) as PermissionAnswer;
    if (body.behavior !== "allow" && body.behavior !== "deny") throw new HttpError(400, { error: "behavior must be allow or deny" });
    await driver.answer(requestId, body);
    return { ok: true };
  }
  async interrupt(id: string) {
    const driver = await this.must(id);
    if (!driver.capabilities.interrupt) throw new HttpError(409, { error: "capability interrupt not available" });
    await driver.interrupt();
    return { ok: true };
  }
  async patch(id: string, req: Request) {
    const driver = await this.must(id);
    const body = (await req.json().catch(() => ({}))) as { permissionMode?: unknown };
    if (typeof body.permissionMode === "string") {
      if (!driver.setPermissionMode) throw new HttpError(409, { error: "permission mode cannot be changed on this session" });
      await driver.setPermissionMode(body.permissionMode);
    }
    return driver.summary();
  }
  async remove(id: string) {
    const driver = this.d.store.get(id);
    if (!driver) {
      if (await this.find(id)) throw new HttpError(409, { error: "terminal sessions cannot be stopped from here" });
      throw new HttpError(404, { error: "unknown session" });
    }
    await driver.stop();
    this.d.store.remove(id);
  }
  events(id: string, after: number): Response {
    if (!this.d.store.get(id)) throw new HttpError(404, { error: "no live session" });
    const src = this.d.store.subscribe(id, after);
    return sse((async function* () { for await (const e of src) yield { id: e.seq, event: e.type, data: e.data }; })());
  }
  allEvents(): Response {
    const src = this.d.store.subscribeAll();
    return sse((async function* () { for await (const c of src) yield { event: "session", data: c }; })());
  }

  private async find(id: string): Promise<Driver | undefined> {
    const live = this.d.store.get(id);
    if (live) return live;
    const a = (await this.d.agents()).find((x) => x.sessionId === id);
    return a ? this.d.terminalFor(a) : undefined;
  }
  private async must(id: string): Promise<Driver> {
    const driver = await this.find(id);
    if (!driver) throw new HttpError(404, { error: "unknown session" });
    return driver;
  }
}
