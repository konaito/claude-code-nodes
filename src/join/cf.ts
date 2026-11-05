// cf CLI の包み。Access アプリ、サービストークン、トンネル、DNS を「あるべき形」に揃える。cf は OAuth で動くので、秘密を argv に渡すことはない
import type { Runner } from "../engine/agents";

export type CfRunner = Runner; // 本物は cf を spawn し、-q を付ける
export class CfError extends Error { constructor(msg: string) { super(msg); this.name = "CfError"; } }

export const realCf: CfRunner = async (args) => {
  const p = Bun.spawn(["cf", ...args, "-q"], { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
  const code = await p.exited;
  return { stdout: code === 0 ? stdout : `${stdout}\n${stderr}`.trim(), code };
};

async function call<T = unknown>(cf: CfRunner, args: string[]): Promise<T> {
  const r = await cf(args);
  if (r.code !== 0) throw new CfError(`cf ${args.slice(0, 4).join(" ")} failed: ${r.stdout.slice(0, 500)}`);
  if (!r.stdout.trim()) return undefined as T;
  let v: unknown;
  try { v = JSON.parse(r.stdout); } catch { throw new CfError(`cf ${args.slice(0, 3).join(" ")} returned non-json`); }
  return (v && typeof v === "object" && "result" in (v as Record<string, unknown>) ? (v as { result: T }).result : (v as T));
}
const body = (o: unknown) => ["--body", JSON.stringify(o)];

type App = { id: string; name: string; aud: string };
type Policy = { name: string; decision: string; include: unknown[] };
function appBody(o: { name: string; hosts: string[]; sessionDuration?: string; policies: Policy[] }) {
  return {
    name: o.name, type: "self_hosted", domain: o.hosts[0], self_hosted_domains: o.hosts,
    ...(o.sessionDuration ? { session_duration: o.sessionDuration } : {}),
    app_launcher_visible: false, policies: o.policies,
  };
}
async function ensureApp(cf: CfRunner, name: string, b: unknown): Promise<App> {
  const apps = await call<App[]>(cf, ["zero-trust", "access", "applications", "list"]);
  const found = (apps ?? []).find((a) => a.name === name);
  return found
    ? call<App>(cf, ["zero-trust", "access", "applications", "update", found.id, ...body(b)])
    : call<App>(cf, ["zero-trust", "access", "applications", "create", ...body(b)]);
}

// Access アプリ cc。人の email の allow と、ノード用サービストークンの non_identity
export async function ensureAccessApp(cf: CfRunner, o: { name: string; hosts: string[]; sessionDuration: string; email: string; serviceTokenId: string }): Promise<{ id: string; aud: string }> {
  const app = await ensureApp(cf, o.name, appBody({
    name: o.name, hosts: o.hosts, sessionDuration: o.sessionDuration,
    policies: [
      { name: "owner", decision: "allow", include: [{ email: { email: o.email } }] },
      { name: "nodes", decision: "non_identity", include: [{ service_token: { token_id: o.serviceTokenId } }] },
    ],
  }));
  return { id: app.id, aud: app.aud };
}

// Bypass アプリ cc-install。<host>/install だけ Access を外す
export async function ensureBypassApp(cf: CfRunner, o: { name: string; hosts: string[] }): Promise<{ id: string }> {
  const app = await ensureApp(cf, o.name, appBody({
    name: o.name, hosts: o.hosts.map((h) => `${h}/install`),
    policies: [{ name: "public", decision: "bypass", include: [{ everyone: {} }] }],
  }));
  return { id: app.id };
}

// サービストークン。secret は作ったときにしか返らない
export async function ensureServiceToken(cf: CfRunner, o: { name: string; duration: string }): Promise<{ id: string; clientId: string; clientSecret?: string }> {
  type Tok = { id: string; name: string; client_id: string; client_secret?: string };
  const list = await call<Tok[]>(cf, ["zero-trust", "access", "service-tokens", "list"]);
  const found = (list ?? []).find((t) => t.name === o.name);
  if (found) return { id: found.id, clientId: found.client_id };
  const t = await call<Tok>(cf, ["zero-trust", "access", "service-tokens", "create", ...body({ name: o.name, duration: o.duration })]);
  return { id: t.id, clientId: t.client_id, clientSecret: t.client_secret };
}

type Tunnel = { id: string; name: string; deleted_at?: string | null };
const tunnelName = (name: string) => `cc-${name}`;
async function findTunnel(cf: CfRunner, name: string): Promise<Tunnel | undefined> {
  const list = await call<Tunnel[]>(cf, ["tunnels", "list"]);
  return (list ?? []).find((t) => t.name === tunnelName(name) && !t.deleted_at);
}
type Ingress = { hostname?: string; service: string };
const ingressFor = (hostname: string, port: number): Ingress => ({ hostname, service: `http://127.0.0.1:${port}` });
async function setIngress(cf: CfRunner, tunnelId: string, ingress: Ingress[]) {
  await call(cf, ["tunnels", "config", "update", tunnelId, ...body({ config: { ingress: [...ingress, { service: "http_status:404" }] } })]);
}
type Dns = { id: string; name: string; type: string };
async function createCname(cf: CfRunner, zone: string, name: string, tunnelId: string) {
  await call(cf, ["dns", "records", "create", "-z", zone, ...body({ type: "CNAME", name, content: `${tunnelId}.cfargotunnel.com`, proxied: true })]);
}
async function deleteCname(cf: CfRunner, zone: string, name: string) {
  const list = await call<Dns[]>(cf, ["dns", "records", "list", "-z", zone]);
  for (const r of (list ?? []).filter((d) => d.name === name && d.type === "CNAME")) await call(cf, ["dns", "records", "delete", r.id, "-z", zone]);
}

// リモート管理のトンネルを作り、ingress と DNS を向け、トークンを返す。トークンは呼び手が端末にだけ出す
export async function createNodeTunnel(cf: CfRunner, o: { name: string; hostname: string; port: number; zone: string }): Promise<{ tunnelId: string; token: string }> {
  const t = await call<Tunnel>(cf, ["tunnels", "create", "--name", tunnelName(o.name), "--config-src", "cloudflare"]);
  await setIngress(cf, t.id, [ingressFor(o.hostname, o.port)]);
  await createCname(cf, o.zone, o.hostname, t.id);
  const tok = await call<string | { token: string }>(cf, ["tunnels", "token", "get", t.id]);
  const token = typeof tok === "string" ? tok : tok.token;
  if (!token) throw new CfError("tunnel token is empty");
  return { tunnelId: t.id, token };
}

// 既にあるノードのトンネルトークンを読み直す（参加トークンを出し直すとき用）
export async function nodeTunnelToken(cf: CfRunner, o: { name: string }): Promise<{ tunnelId: string; token: string }> {
  const t = await findTunnel(cf, o.name);
  if (!t) throw new CfError(`tunnel ${tunnelName(o.name)} not found`);
  const tok = await call<string | { token: string }>(cf, ["tunnels", "token", "get", t.id]);
  const token = typeof tok === "string" ? tok : tok.token;
  if (!token) throw new CfError("tunnel token is empty");
  return { tunnelId: t.id, token };
}

export async function removeNodeTunnel(cf: CfRunner, o: { name: string; hostname: string; zone: string }): Promise<void> {
  await deleteCname(cf, o.zone, o.hostname);
  const t = await findTunnel(cf, o.name);
  if (t) await call(cf, ["tunnels", "delete", t.id]);
}

// 入口。そのノードのトンネルの ingress に cc.fybe.jp を足し、CNAME を向ける（移行日用）
export async function setEntry(cf: CfRunner, o: { name: string; entryHost: string; port: number; zone: string }): Promise<void> {
  const t = await findTunnel(cf, o.name);
  if (!t) throw new CfError(`tunnel ${tunnelName(o.name)} not found`);
  const cur = await call<{ config?: { ingress?: Ingress[] } }>(cf, ["tunnels", "config", "get", t.id]);
  const kept = (cur?.config?.ingress ?? []).filter((i) => i.hostname && i.hostname !== o.entryHost);
  await setIngress(cf, t.id, [...kept, ingressFor(o.entryHost, o.port)]);
  await deleteCname(cf, o.zone, o.entryHost);
  await createCname(cf, o.zone, o.entryHost, t.id);
}
