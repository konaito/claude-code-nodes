// HTTP の入口。呼び手を1回決めてから URL を手で振り分け、Sessions に渡す。フレームワークは使わない
import { Sessions, type Deps } from "./sessions";
import { HttpError, json, toResponse } from "./errors";
import type { Caller } from "../identity/identity";
import { installerScript } from "../join/installer";
import { bundle } from "../join/bundle";
import { BUNDLE_PATH, CLI_NAME, LEGACY_BUNDLE_PATH, MCP_PATH, SKILL_MD_PATH } from "../names";
import { pageHtml } from "../web/page";
import { mcpHandler, type ApiCall } from "../mcp/server";
import { skillMd } from "../mcp/skill-md";
import { isPtyHook, ptyHook, terminalInput, terminalResize, terminalStream } from "./terminal";
import { etagOf } from "./list-watch";
import type { State } from "../sessions/types";
export type { Deps, HostInfo } from "./sessions";

// ブラウザからの変更は、同じオリジンのページからだけ受ける。別サイトの form や fetch を断る。
// 呼び手の種類は問わない（手元のノードも、同じ機械のブラウザで開いた罠のページから狙われる）。CLI と中継は Origin を送らない
function guardCsrf(req: Request, url: URL, _caller: Caller) {
  if (req.method === "GET" || req.method === "HEAD") return;
  // トンネルの裏ではノードは http で受けるが、ブラウザの Origin は https なので、scheme ではなく host で比べる
  const origin = req.headers.get("origin");
  if (origin) {
    let host = "";
    try { host = new URL(origin).host; } catch { host = ""; }
    if (host !== url.host) throw new HttpError(403, { error: "cross-origin request" });
  }
  const site = req.headers.get("sec-fetch-site");
  if (site && site !== "same-origin" && site !== "none") throw new HttpError(403, { error: "cross-site request" });
}

// 公開の道が本文に書く入口の URL。要求のホスト名から決める（Cloudflare 経由なら公開ホスト名、手元なら 127.0.0.1）。
// 認証なしで Host を本文に映す経路なので、ホスト名の文字だけを通す
function originOf(req: Request, url: URL): string {
  const host = req.headers.get("x-forwarded-host") ?? req.headers.get("host") ?? url.host;
  if (!/^[A-Za-z0-9.:[\]-]+$/.test(host)) throw new HttpError(400, { error: "bad host" });
  const scheme = /^(127\.0\.0\.1|localhost)(:|$)/.test(host) ? "http" : "https";
  return `${scheme}://${host}`;
}

// 認証の要らない道。インストーラ、その実行物、/skill.md
async function publicRoute(req: Request, url: URL, appRoot: string): Promise<Response> {
  if (req.method !== "GET") throw new HttpError(405, { error: "method not allowed" });
  if (url.pathname === "/install") {
    return new Response(installerScript({ entry: originOf(req, url), cliName: CLI_NAME }), { headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" } });
  }
  if (url.pathname === SKILL_MD_PATH) {
    return new Response(await skillMd(appRoot, originOf(req, url)), { headers: { "content-type": "text/markdown; charset=utf-8", "cache-control": "no-cache" } });
  }
  // Cloudflare は .gz を既定で cache するので、古い実行物を配らないよう no-store を付ける。
  // 旧のパスは、まだ更新していないノードの ccn update が取りに来るので移行の間は同じものを配る
  if (url.pathname === BUNDLE_PATH || url.pathname === LEGACY_BUNDLE_PATH) return new Response(bundle(appRoot), { headers: { "content-type": "application/gzip", "cache-control": "no-store" } });
  throw new HttpError(404, { error: "not found" });
}

// 呼び手の解決をしない経路（インストーラの配布と /skill.md）
const isPublic = (path: string) => path === "/install" || path.startsWith("/install/") || path === SKILL_MD_PATH;

export function createApp(deps: Deps) {
  const s = new Sessions(deps);
  const store = deps.store;
  // 呼び手が決まった要求を処理する。/n/<peer>/api/... は中継で、相手が自分なら手元で処理する
  async function dispatch(req: Request, caller: Caller): Promise<Response> {
    const url = new URL(req.url);
    const n = url.pathname.match(/^\/n\/([^/]+)\/(api\/.*)$/);
    if (n) {
      const [, peer, rest] = n;
      if (peer !== deps.nodeName) return await deps.relay.forward(peer!, rest!, req, caller);
      return await route(new Request(new URL(`/${rest}${url.search}`, url).toString(), req), s, caller, store);
    }
    return await route(req, s, caller, store);
  }
  // MCP のツールが使う API の呼び出し。HTTP の API と同じ道（dispatch）を、同じ呼び手で通す。相手のノードは中継を通す
  const apiAt = (base: URL): ApiCall => async (caller, method, peer, path, body) => {
    const p = peer && peer !== deps.nodeName ? `/n/${encodeURIComponent(peer)}${path}` : path;
    const init: RequestInit = { method };
    if (body !== undefined) { init.headers = { "content-type": "application/json" }; init.body = JSON.stringify(body); }
    const r = await dispatch(new Request(new URL(p, base), init), caller).catch(toResponse);
    const text = await r.text();
    let value: unknown;
    try { value = text ? JSON.parse(text) : undefined; } catch { value = { error: text.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim().slice(0, 200) }; }
    return { status: r.status, body: value };
  };
  const mcp = mcpHandler({ nodeName: deps.nodeName, ...deps.mcp });
  return {
    async fetch(req: Request): Promise<Response> {
      try {
        const url = new URL(req.url);
        if (isPublic(url.pathname)) return await publicRoute(req, url, deps.appRoot);
        // PTY の子の hooks。呼び手（Access）ではなく、同じ機械とセッションごとの token で確かめる
        if (isPtyHook(url.pathname)) return await ptyHook(deps.store, req, url);
        const caller = await deps.identity.callerOf(req);
        guardCsrf(req, url, caller);
        if (url.pathname === MCP_PATH) return await mcp(req, caller, apiAt(url));
        return await dispatch(req, caller);
      } catch (e) { return toResponse(e); }
    },
  };
}

const after = (url: URL) => Number(url.searchParams.get("after") ?? 0) || 0;
// EventSource の再接続は Last-Event-ID を付けてくるので、あれば after より優先する
const cursor = (req: Request, url: URL) => Number(req.headers.get("last-event-id") ?? "") || after(url);

// ?state= の絞り込み。live は exited 以外。カンマで複数の状態を並べられる。無ければ絞らない
const STATES: State[] = ["running", "waiting_permission", "idle", "exited"];
function statesOf(url: URL): Set<State> | null {
  const v = url.searchParams.get("state");
  if (v === null || v === "") return null;
  const out = new Set<State>();
  for (const w of v.split(",").map((x) => x.trim()).filter(Boolean)) {
    if (w === "live") { for (const st of STATES) if (st !== "exited") out.add(st); }
    else if ((STATES as string[]).includes(w)) out.add(w as State);
    else throw new HttpError(400, { error: `unknown state: ${w}`, states: ["live", ...STATES] });
  }
  return out;
}
// 一覧の応答。本文の ETag を付け、If-None-Match が同じなら 304 で本文を返さない
function listResponse(req: Request, list: unknown): Response {
  const body = JSON.stringify(list);
  const etag = etagOf(body);
  const inm = req.headers.get("if-none-match");
  if (inm && inm.split(",").some((t) => t.trim().replace(/^W\//, "") === etag)) return new Response(null, { status: 304, headers: { etag, "cache-control": "no-cache" } });
  return new Response(body, { headers: { "content-type": "application/json; charset=utf-8", etag, "cache-control": "no-cache" } });
}

async function route(req: Request, s: Sessions, caller: Caller, store: Deps["store"]): Promise<Response> {
  const url = new URL(req.url);
  const parts = url.pathname.split("/").filter(Boolean);
  const m = req.method;
  if ((url.pathname === "/" || url.pathname === "/index.html") && m === "GET") {
    return new Response(await pageHtml(), { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-cache" } });
  }
  if (parts[0] === "api") {
    if (parts[1] === "host" && parts.length === 2 && m === "GET") return json(await s.host());
    if (parts[1] === "events" && parts.length === 2 && m === "GET") return s.allEvents();
    if (parts[1] === "peers" && parts.length === 2 && m === "GET") return json(await s.peers());
    if (parts[1] === "depth" && parts.length === 2 && m === "GET") {
      const raw = url.searchParams.get("hops");
      const hops = raw ? Number(raw) : NaN;
      return json(await s.depth(url.searchParams.get("session"), Number.isInteger(hops) ? hops : null, caller));
    }
    if (parts[1] === "places" && parts.length === 2 && m === "GET") {
      const limit = Number(url.searchParams.get("limit") ?? "");
      return json(await s.places(url.searchParams.get("q"), Number.isFinite(limit) && limit > 0 ? limit : null));
    }
    // teleport の移動先の口
    if (parts[1] === "teleport" && m === "POST") {
      if (parts.length === 2) return json(await s.teleportImport(req, url, caller), 201);
      if (parts.length === 3 && parts[2] === "check") return json(await s.teleportCheck(req));
    }
    if (parts[1] === "sessions") {
      const [, , id, sub, rid] = parts;
      // 一覧の変化を流す SSE（#24）。セッションの id は UUID なので stream とは重ならない
      if (id === "stream" && parts.length === 3 && m === "GET") {
        return s.stream({ parent: url.searchParams.get("parent"), states: statesOf(url) }, req.headers.get("last-event-id"));
      }
      if (!id) {
        if (m === "GET") return listResponse(req, await s.list(url.searchParams.get("parent"), statesOf(url)));
        if (m === "POST") return json(await s.create(req, caller), 201);
      } else if (!sub) {
        if (m === "GET") return json(await s.detail(id));
        if (m === "PATCH") return json(await s.patch(id, req));
        if (m === "DELETE") { await s.remove(id); return new Response(null, { status: 204 }); }
      } else if (sub === "messages" && !rid) {
        if (m === "GET") return json(await s.messages(id, after(url)));
        if (m === "POST") return json(await s.send(id, req, caller));
      } else if (sub === "events" && !rid && m === "GET") {
        return s.events(id, cursor(req, url));
      } else if (sub === "permissions" && rid && m === "POST") {
        return json(await s.answer(id, rid, req));
      } else if (sub === "interrupt" && !rid && m === "POST") {
        return json(await s.interrupt(id));
      } else if (sub === "terminal") {
        // 端末の口（PTY のセッションだけ）。rid は input か resize
        if (!rid && m === "GET") return terminalStream(store, id, req, url);
        if (rid === "input" && parts.length === 5 && m === "POST") return json(await terminalInput(store, id, req));
        if (rid === "resize" && parts.length === 5 && m === "POST") return json(await terminalResize(store, id, req));
      } else if (sub === "teleport" && !rid) {
        if (m === "GET") return json(await s.teleportInfo(id));
        if (m === "POST") return json(await s.teleport(id, req, caller));
      } else if (sub === "export" && !rid && m === "POST") {
        return await s.exportResponse(id, req);
      }
    }
  }
  throw new HttpError(404, { error: "not found" });
}
