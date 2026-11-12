// API のエラーを HTTP の応答に統一する。境界の例外（能力なし、終了済み、ソケット無し、見つからない）をここで状態コードに変える
import { BusyError, CapabilityError, ExitedError, NotFoundError, SocketGoneError } from "../engine/driver";
import { AccessDenied } from "../identity/identity";
import { RegistryError } from "../registry/registry";
import { PeerUnreachableError, RelayNotConfiguredError, UnknownPeerError } from "../relay/relay";
import { GitError } from "../teleport/git";
import { PlaceError } from "../teleport/place";
import { IdConflictError, NoTranscriptError } from "../teleport/transcript";
import { BadPackError, PackTooLargeError } from "../teleport/pack";

export class HttpError extends Error {
  constructor(public status: number, public body: Record<string, unknown>) { super(String(body.error ?? status)); this.name = "HttpError"; }
}
export const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json; charset=utf-8" } });

export function toResponse(e: unknown): Response {
  if (e instanceof HttpError) return json(e.body, e.status);
  if (e instanceof AccessDenied) return json({ error: e.message }, e.status);
  if (e instanceof RegistryError) return json({ error: e.message }, e.status);
  if (e instanceof UnknownPeerError) return json({ error: e.message, peer: e.peer }, 404);
  if (e instanceof PeerUnreachableError) return json({ error: e.message, peer: e.peer }, 502);
  if (e instanceof RelayNotConfiguredError) return json({ error: e.message }, 503);
  if (e instanceof CapabilityError) return json({ error: e.message, capability: e.capability }, 409);
  if (e instanceof ExitedError) return json({ error: e.message, hint: "resume" }, 409);
  if (e instanceof SocketGoneError) return json({ error: e.message }, 410);
  if (e instanceof NotFoundError) return json({ error: e.message }, 404);
  if (e instanceof BusyError) return json({ error: e.message }, 409);
  // teleport。移動先の状態で断るもの（汚れ、分岐、同じ id）は 409、入力の誤りは 400
  if (e instanceof GitError) return json({ error: e.message, code: e.code, detail: e.detail }, e.code === "failed" ? 500 : e.code === "not_repo" || e.code === "no_commits" ? 400 : 409);
  if (e instanceof PlaceError) return json({ error: e.message, code: e.code, detail: e.detail, hint: "pass cwd" }, e.code === "ambiguous" || e.code === "exists" ? 409 : 400);
  if (e instanceof IdConflictError) return json({ error: e.message, code: "id_conflict" }, 409);
  if (e instanceof NoTranscriptError) return json({ error: e.message }, 404);
  if (e instanceof PackTooLargeError) return json({ error: e.message }, 413);
  if (e instanceof BadPackError) return json({ error: e.message }, 400);
  console.error(e);
  return json({ error: e instanceof Error ? e.message : String(e) }, 500);
}
