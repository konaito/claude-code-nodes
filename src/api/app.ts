// HTTP の入口。呼び手を1回決めてから URL を手で振り分け、Sessions に渡す。フレームワークは使わない
import { Sessions, type Deps } from "./sessions";
import { HttpError, json, toResponse } from "./errors";
import type { Caller } from "../identity/identity";
import { installerScript } from "../join/installer";
import { bundle } from "../join/bundle";
import { CLI_NAME } from "../cli/name";
export type { Deps, HostInfo } from "./sessions";

// ブラウザ（Access の cookie を持つ人）からの変更は、同じオリジンのページからだけ受ける。別サイトの form や fetch を断る
function guardCsrf(req: Request, url: URL, caller: Caller) {
  if (caller.kind !== "user" || req.method === "GET" || req.method === "HEAD") return;
  const origin = req.headers.get("origin");
  if (origin && origin !== url.origin) throw new HttpError(403, { error: "cross-origin request" });
  const site = req.headers.get("sec-fetch-site");
  if (site && site !== "same-origin" && site !== "none") throw new HttpError(403, { error: "cross-site request" });
}

// インストーラとその実行物。入口の URL は要求のホスト名から決める（Cloudflare 経由なら公開ホスト名、手元なら 127.0.0.1）
function install(req: Request, url: URL, appRoot: string): Response {
  if (req.method !== "GET") throw new HttpError(405, { error: "method not allowed" });
  if (url.pathname === "/install") {
    const host = req.headers.get("x-forwarded-host") ?? req.headers.get("host") ?? url.host;
    const scheme = /^(127\.0\.0\.1|localhost)(:|$)/.test(host) ? "http" : "https";
    return new Response(installerScript({ entry: `${scheme}://${host}`, cliName: CLI_NAME }), { headers: { "content-type": "text/plain; charset=utf-8" } });
  }
  if (url.pathname === "/install/cc.tar.gz") return new Response(bundle(appRoot), { headers: { "content-type": "application/gzip" } });
  throw new HttpError(404, { error: "not found" });
}

// 呼び手の解決をしない経路（インストーラの配布）
const isPublic = (path: string) => path === "/install" || path.startsWith("/install/");

export function createApp(deps: Deps) {
  const s = new Sessions(deps);
  return {
    async fetch(req: Request): Promise<Response> {
      try {
        const url = new URL(req.url);
        if (isPublic(url.pathname)) return install(req, url, deps.appRoot);
        const caller = await deps.identity.callerOf(req);
        guardCsrf(req, url, caller);
        // /n/<peer>/api/... は中継。相手が自分なら手元で処理する
        const n = url.pathname.match(/^\/n\/([^/]+)\/(api\/.*)$/);
        if (n) {
          const [, peer, rest] = n;
          if (peer !== deps.nodeName) return await deps.relay.forward(peer!, rest!, req, caller);
          return await route(new Request(new URL(`/${rest}${url.search}`, url).toString(), req), s, caller);
        }
        return await route(req, s, caller);
      } catch (e) { return toResponse(e); }
    },
  };
}

const after = (url: URL) => Number(url.searchParams.get("after") ?? 0) || 0;
// EventSource の再接続は Last-Event-ID を付けてくるので、あれば after より優先する
const cursor = (req: Request, url: URL) => Number(req.headers.get("last-event-id") ?? "") || after(url);

async function route(req: Request, s: Sessions, caller: Caller): Promise<Response> {
  const url = new URL(req.url);
  const parts = url.pathname.split("/").filter(Boolean);
  const m = req.method;
  if (parts[0] === "api") {
    if (parts[1] === "host" && parts.length === 2 && m === "GET") return json(await s.host());
    if (parts[1] === "events" && parts.length === 2 && m === "GET") return s.allEvents();
    if (parts[1] === "peers" && parts.length === 2 && m === "GET") return json(await s.peers());
    if (parts[1] === "sessions") {
      const [, , id, sub, rid] = parts;
      if (!id) {
        if (m === "GET") return json(await s.list(url.searchParams.get("parent")));
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
      }
    }
  }
  throw new HttpError(404, { error: "not found" });
}
