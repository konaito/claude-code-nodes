// HTTP の入口。URL を手で振り分け、Sessions に渡す。フレームワークは使わない
import { Sessions, type Deps } from "./sessions";
import { HttpError, json, toResponse } from "./errors";
export type { Deps, HostInfo } from "./sessions";

export function createApp(deps: Deps) {
  const s = new Sessions(deps);
  return {
    async fetch(req: Request): Promise<Response> {
      try { return await route(req, s); } catch (e) { return toResponse(e); }
    },
  };
}

const after = (url: URL) => Number(url.searchParams.get("after") ?? 0) || 0;

async function route(req: Request, s: Sessions): Promise<Response> {
  const url = new URL(req.url);
  const parts = url.pathname.split("/").filter(Boolean);
  const m = req.method;
  if (parts[0] === "api") {
    if (parts[1] === "host" && parts.length === 2 && m === "GET") return json(await s.host());
    if (parts[1] === "events" && parts.length === 2 && m === "GET") return s.allEvents();
    if (parts[1] === "sessions") {
      const [, , id, sub, rid] = parts;
      if (!id) {
        if (m === "GET") return json(await s.list(url.searchParams.get("parent")));
        if (m === "POST") return json(await s.create(req), 201);
      } else if (!sub) {
        if (m === "GET") return json(await s.detail(id));
        if (m === "PATCH") return json(await s.patch(id, req));
        if (m === "DELETE") { await s.remove(id); return new Response(null, { status: 204 }); }
      } else if (sub === "messages" && !rid) {
        if (m === "GET") return json(await s.messages(id, after(url)));
        if (m === "POST") return json(await s.send(id, req));
      } else if (sub === "events" && !rid && m === "GET") {
        return s.events(id, after(url));
      } else if (sub === "permissions" && rid && m === "POST") {
        return json(await s.answer(id, rid, req));
      } else if (sub === "interrupt" && !rid && m === "POST") {
        return json(await s.interrupt(id));
      }
    }
  }
  throw new HttpError(404, { error: "not found" });
}
