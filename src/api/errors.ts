// API のエラーを HTTP の応答に統一する。境界の例外（能力なし、終了済み、ソケット無し、見つからない）をここで状態コードに変える
import { CapabilityError } from "../engine/driver";
import { ExitedError, NotFoundError } from "../engine/node-driver";
import { SocketGoneError } from "../engine/terminal-driver";

export class HttpError extends Error {
  constructor(public status: number, public body: Record<string, unknown>) { super(String(body.error ?? status)); this.name = "HttpError"; }
}
export const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json; charset=utf-8" } });

export function toResponse(e: unknown): Response {
  if (e instanceof HttpError) return json(e.body, e.status);
  if (e instanceof CapabilityError) return json({ error: e.message, capability: e.capability }, 409);
  if (e instanceof ExitedError) return json({ error: e.message, hint: "resume" }, 409);
  if (e instanceof SocketGoneError) return json({ error: e.message }, 410);
  if (e instanceof NotFoundError) return json({ error: e.message }, 404);
  console.error(e);
  return json({ error: e instanceof Error ? e.message : String(e) }, 500);
}
