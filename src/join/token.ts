// 参加トークン。新しい機械に人が運ぶ1本の文字列。中身はトンネルトークン、ノード用サービストークン、登録簿の読み取りトークン、名前、公開値
import { homedir } from "node:os";
import type { Config } from "../config";

export type JoinToken = {
  v: 1;
  name: string;
  port: number;
  domain: string;
  zone: string;
  teamDomain: string;
  aud: string;
  accountId: string;
  entry: string;
  tunnelToken: string;
  serviceToken: { clientId: string; clientSecret: string };
  cfApiToken: string;
};
export class JoinTokenError extends Error { constructor(msg: string) { super(msg); this.name = "JoinTokenError"; } }

const STRINGS = ["name", "domain", "zone", "teamDomain", "aud", "accountId", "entry", "tunnelToken", "cfApiToken"] as const;

export function encodeJoinToken(t: JoinToken): string {
  return Buffer.from(JSON.stringify(t), "utf8").toString("base64url");
}

export function decodeJoinToken(s: string): JoinToken {
  const trimmed = s.trim();
  if (!trimmed) throw new JoinTokenError("join token is empty");
  if (!/^[A-Za-z0-9_-]+$/.test(trimmed)) throw new JoinTokenError("join token is not base64url");
  let raw: Record<string, unknown>;
  try { raw = JSON.parse(Buffer.from(trimmed, "base64url").toString("utf8")) as Record<string, unknown>; } catch { throw new JoinTokenError("join token is not json"); }
  if (raw.v !== 1) throw new JoinTokenError("join token version is not 1");
  for (const k of STRINGS) if (typeof raw[k] !== "string" || !raw[k]) throw new JoinTokenError(`join token lacks ${k}`);
  if (!Number.isInteger(raw.port)) throw new JoinTokenError("join token lacks port");
  const st = raw.serviceToken as Record<string, unknown> | undefined;
  if (!st || typeof st.clientId !== "string" || typeof st.clientSecret !== "string") throw new JoinTokenError("join token lacks serviceToken");
  const t: JoinToken = { v: 1, port: raw.port as number, serviceToken: { clientId: st.clientId, clientSecret: st.clientSecret } } as JoinToken;
  for (const k of STRINGS) t[k] = raw[k] as string;
  return t;
}

// トンネルトークンは cloudflared 用に別ファイルへ置くので、設定には入れない
export function configFromToken(t: JoinToken): Config {
  return {
    name: t.name, port: t.port, roots: [homedir()],
    domain: t.domain, zone: t.zone, teamDomain: t.teamDomain, aud: t.aud, accountId: t.accountId, entry: t.entry,
    serviceToken: { ...t.serviceToken }, cfApiToken: t.cfApiToken,
  };
}
