// cc の参加側の命令。setup（1回だけの準備）、node add/remove、entry、install、update、uninstall、doctor、serve。cf、常駐、端末、ファイルは deps の裏
import { chmodSync, existsSync, mkdirSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { entryOf, loadConfig, saveConfig, type Config } from "../config";
import type { Runner } from "../engine/agents";
import { createNodeTunnel, ensureAccessApp, ensureBypassApp, ensureServiceToken, removeNodeTunnel, setEntry, type CfRunner } from "../join/cf";
import { configFromToken, decodeJoinToken, encodeJoinToken, JoinTokenError, type JoinToken } from "../join/token";
import { serviceManager, type Paths, type Platform, type ServiceManager } from "../join/services";
import { withCrossSessionInbound, SettingsError } from "../join/settings";
import { linkSkill, realFs } from "../join/skill-links";
import { CliError, clientFor, api } from "./client";
import { readUntilResult } from "./read";
import type { Ctx } from "./commands";
import type { Parsed } from "./args";
import { CLI_NAME } from "./name";

export type JoinDeps = {
  cf: CfRunner;
  services: (platform: Platform, p: Paths) => ServiceManager;
  platform: Platform;
  home: string; configDir: string; appDir: string; bunPath: string; cloudflaredPath: string; uid: number;
  tty: (prompt: string) => Promise<string>;   // /dev/tty から1行
  ttyWrite: (text: string) => void;           // /dev/tty へ
  clipboard?: (text: string) => Promise<boolean>;
  run: Runner;
  now: () => Date;
};
export const TESTED_CLAUDE = "2.1.318";
const DEFAULTS = { email: "ceo@fybe.jp", domain: "cc.fybe.jp", zone: "fybe.jp", teamDomain: "fybejp.cloudflareaccess.com", accountId: "9b67e2ec0e2cf3359289e1fc860d3777" };
const str = (v: string | true | undefined) => (typeof v === "string" ? v : undefined);
const num = (v: string | true | undefined, d: number) => { const n = Number(str(v)); return str(v) !== undefined && Number.isFinite(n) ? n : d; };

export function joinCommands(d: JoinDeps) {
  const configPath = join(d.configDir, "cc.json");
  const paths = (): Paths => ({ home: d.home, appDir: d.appDir, configDir: d.configDir, logDir: join(d.home, ".local", "share", "cc", "log"), bun: d.bunPath, cloudflared: d.cloudflaredPath, uid: d.uid });
  const services = () => d.services(d.platform, paths());
  const needSetup = (cfg: Config): Required<Pick<Config, "domain" | "zone" | "teamDomain" | "aud" | "accountId" | "serviceToken" | "cfApiToken">> & Config => {
    for (const k of ["domain", "zone", "teamDomain", "aud", "accountId", "serviceToken", "cfApiToken"] as const) if (!cfg[k]) throw new CliError(1, `cc.json に ${k} が無い。先に ${CLI_NAME} setup を実行する`);
    return cfg as ReturnType<typeof needSetup>;
  };

  async function setup(flags: Parsed["flags"], ctx: Ctx): Promise<number> {
    const hosts = (str(flags.hosts) ?? "").split(",").map((s) => s.trim()).filter(Boolean);
    if (!hosts.length) throw new CliError(1, "--hosts <a,b> が要る（例: '*.cc.fybe.jp'）");
    const had = existsSync(configPath);
    const cfg = loadConfig(configPath);
    const tok = await ensureServiceToken(d.cf, { name: "cc-node", duration: "8760h" });
    let serviceToken: Config["serviceToken"];
    if (tok.clientSecret) serviceToken = { clientId: tok.clientId, clientSecret: tok.clientSecret };
    else if (cfg.serviceToken?.clientId === tok.clientId) serviceToken = cfg.serviceToken;
    else throw new CliError(1, `サービストークン cc-node（${tok.id}）は既にあるが secret が手元に無い。cf zero-trust access service-tokens rotate ${tok.id} で取り直すか、消してからやり直す`);
    const email = str(flags.email) ?? DEFAULTS.email;
    const app = await ensureAccessApp(d.cf, { name: "cc", hosts, sessionDuration: "720h", email, serviceTokenId: tok.id });
    const bypass = await ensureBypassApp(d.cf, { name: "cc-install", hosts });
    const cfApiToken = cfg.cfApiToken ?? (await d.tty("CF API トークン（Account / Cloudflare Tunnel / Read）: ")).trim();
    if (!cfApiToken) throw new CliError(1, "CF API トークンが空");
    const next: Config = {
      name: str(flags.name) ?? cfg.name, port: num(flags.port, cfg.port), roots: had ? cfg.roots : [d.home],
      domain: str(flags.domain) ?? cfg.domain ?? DEFAULTS.domain, zone: str(flags.zone) ?? cfg.zone ?? DEFAULTS.zone,
      teamDomain: str(flags["team-domain"]) ?? cfg.teamDomain ?? DEFAULTS.teamDomain, aud: app.aud,
      accountId: str(flags["account-id"]) ?? cfg.accountId ?? DEFAULTS.accountId, serviceToken, cfApiToken,
    };
    if (cfg.entry) next.entry = cfg.entry;
    saveConfig(next, configPath);
    ctx.out(`Access アプリ cc: ${app.id} (aud ${app.aud})`);
    ctx.out(`Bypass アプリ cc-install: ${bypass.id}`);
    ctx.out(`サービストークン cc-node: ${tok.id}`);
    ctx.out(`保存した: ${configPath}`);
    return 0;
  }

  async function nodeAdd(name: string | undefined, flags: Parsed["flags"], ctx: Ctx): Promise<number> {
    if (!name) throw new CliError(1, "node add には <name> が要る");
    const cfg = needSetup(loadConfig(configPath));
    const port = num(flags.port, 4322);
    const hostname = `${name}.${cfg.domain}`;
    const entry = entryOf(cfg)!;
    const { tunnelId, token } = await createNodeTunnel(d.cf, { name, hostname, port, zone: cfg.zone });
    const jt: JoinToken = { v: 1, name, port, domain: cfg.domain, zone: cfg.zone, teamDomain: cfg.teamDomain, aud: cfg.aud, accountId: cfg.accountId, entry, tunnelToken: token, serviceToken: cfg.serviceToken, cfApiToken: cfg.cfApiToken };
    const enc = encodeJoinToken(jt);
    if (d.clipboard && (await d.clipboard(enc))) ctx.out("参加トークンをクリップボードに入れた（表示はしない）");
    else { d.ttyWrite(enc + "\n"); ctx.out("参加トークンを端末に出した"); }
    ctx.out(`トンネル cc-${name} (${tunnelId})、ホスト名 ${hostname} → 127.0.0.1:${port}`);
    ctx.out(`新しい機械で: curl -fsSL ${entry}/install | sh`);
    return 0;
  }

  async function install(flags: Parsed["flags"], ctx: Ctx): Promise<number> {
    let token: JoinToken;
    try { token = decodeJoinToken(await ctx.stdin()); } catch (e) { if (e instanceof JoinTokenError) throw new CliError(1, e.message); throw e; }
    const cfg = configFromToken(token);
    // 先に settings.json の新しい中身を作る。壊れていればここで止まり、何も書かない
    const settingsPath = join(d.home, ".claude", "settings.json");
    let settingsNext: string;
    try { settingsNext = existsSync(settingsPath) ? withCrossSessionInbound(realFs.readText(settingsPath) ?? "") : '{\n  "crossSessionInbound": "accept"\n}\n'; }
    catch (e) { if (e instanceof SettingsError) throw new CliError(1, e.message); throw e; }
    saveConfig(cfg, configPath);
    const tokenPath = join(d.configDir, "tunnel.token");
    writeFileSync(tokenPath, token.tunnelToken, { mode: 0o600 });
    chmodSync(tokenPath, 0o600);
    const from = str(flags.from);
    if (from) realFs.copyDir(from, d.appDir);
    realFs.writeText(settingsPath, settingsNext);
    linkSkill({ home: d.home, appDir: d.appDir, configDir: d.configDir, now: d.now() }, realFs);
    await linkBin(ctx);
    await services().install();
    ctx.out(`設定 ${configPath}、常駐を入れた（${d.platform === "darwin" ? "LaunchAgent jp.fybe.cc.*" : "systemd --user cc-*"}）`);
    await doctor(ctx);
    return 0;
  }

  // ~/.local/bin/<CLI_NAME> → <appDir>/bin/cc。PATH に別の同名の命令（macOS の /usr/bin/cc など）があれば置かずに案内する
  async function linkBin(ctx: Ctx) {
    const link = join(d.home, ".local", "bin", CLI_NAME);
    const other = await d.run(["sh", "-c", `command -v ${CLI_NAME}`]);
    const found = other.code === 0 ? other.stdout.trim() : "";
    if (found && found !== link) { ctx.out(`PATH に ${found} があるので ${link} は置かない。使うときは ${join(d.appDir, "bin", "cc")} を呼ぶか alias を作る`); return; }
    mkdirSync(join(d.home, ".local", "bin"), { recursive: true });
    rmSync(link, { force: true });
    symlinkSync(join(d.appDir, "bin", "cc"), link);
  }

  async function update(ctx: Ctx): Promise<number> {
    const cfg = loadConfig(configPath);
    const entry = entryOf(cfg);
    if (!entry) throw new CliError(1, "cc.json に entry も domain も無い");
    const r = await ctx.fetchFn(`${entry}/install/cc.tar.gz`);
    if (!r.ok) throw new CliError(1, `${entry}/install/cc.tar.gz → ${r.status}`);
    const bytes = new Uint8Array(await r.arrayBuffer());
    const newDir = `${d.appDir}.new`;
    const oldDir = `${d.appDir}.old`;
    const tgz = `${d.appDir}.new.tgz`;
    rmSync(newDir, { recursive: true, force: true });
    mkdirSync(newDir, { recursive: true });
    writeFileSync(tgz, bytes);
    const tar = Bun.spawn(["tar", "xzf", tgz, "-C", newDir], { stdout: "ignore", stderr: "pipe" });
    const code = await tar.exited;
    rmSync(tgz, { force: true });
    if (code !== 0) throw new CliError(1, `tar が失敗した: ${await new Response(tar.stderr).text()}`);
    const inst = await d.run([d.bunPath, "install", "--frozen-lockfile", "--production", "--cwd", newDir]);
    if (inst.code !== 0) throw new CliError(1, `bun install が失敗した: ${inst.stdout.slice(0, 300)}`);
    rmSync(oldDir, { recursive: true, force: true });
    if (existsSync(d.appDir)) renameSync(d.appDir, oldDir);
    renameSync(newDir, d.appDir);
    rmSync(oldDir, { recursive: true, force: true });
    await services().restart("node");
    ctx.out(`更新した: ${d.appDir}。node を再起動した`);
    return 0;
  }

  async function uninstall(ctx: Ctx): Promise<number> {
    await services().uninstall();
    rmSync(join(d.home, ".local", "share", "cc"), { recursive: true, force: true });
    rmSync(d.configDir, { recursive: true, force: true });
    rmSync(join(d.home, ".local", "bin", CLI_NAME), { force: true });
    ctx.out("常駐と ~/.local/share/cc と ~/.config/cc を消した。~/.claude/settings.json の crossSessionInbound とスキルのリンクは残している");
    return 0;
  }

  async function doctor(ctx: Ctx): Promise<number> {
    const cfg = loadConfig(configPath);
    let ng = 0;
    const line = (ok: boolean, what: string) => { if (!ok) ng++; ctx.out(`${ok ? "ok" : "ng"} ${what}`); };
    const v = await d.run(["claude", "--version"]).catch(() => ({ stdout: "", code: 1 }));
    const ver = v.stdout.trim();
    line(v.code === 0 && ver.includes(TESTED_CLAUDE), `claude ${ver || "(無い)"}${v.code === 0 && !ver.includes(TESTED_CLAUDE) ? `（試験済みは ${TESTED_CLAUDE}。受信ソケットの行の形は非公開なので、版が違えば端末への注入を確かめる）` : ""}`);
    const ag = await d.run(["claude", "agents", "--json"]).catch(() => ({ stdout: "", code: 1 }));
    line(ag.code === 0, "claude agents --json");
    const st = await services().status().catch(() => ({ node: "unknown", tunnel: "unknown" } as const));
    line(st.node === "running", `常駐 node: ${st.node}`);
    line(st.tunnel === "running", `常駐 tunnel: ${st.tunnel}`);
    const local = clientFor(cfg, undefined, "doctor", ctx.env);
    const host = await api<{ name: string }>(local, "GET", "/api/host", undefined, ctx.fetchFn).catch(() => undefined);
    line(!!host, `手元の API http://127.0.0.1:${cfg.port}/api/host${host ? ` (${host.name})` : ""}`);
    if (cfg.domain && cfg.serviceToken) {
      const remote = await api<{ name: string }>(clientFor(cfg, `${cfg.name}`, "doctor", { ...ctx.env, CLAUDE_CODE_SESSION_ID: undefined }), "GET", "/api/host", undefined, ctx.fetchFn).catch(() => undefined);
      // clientFor は自分の名前だと 127.0.0.1 に向くので、外からの経路は URL を直接組む
      const url = `https://${cfg.name}.${cfg.domain}/api/host`;
      const r = await ctx.fetchFn(url, { headers: { "cf-access-client-id": cfg.serviceToken.clientId, "cf-access-client-secret": cfg.serviceToken.clientSecret } }).catch(() => undefined);
      line(!!(r && r.ok) || !!remote, `外からの API ${url}${r ? ` → ${r.status}` : ""}`);
    } else {
      ctx.out("-- 外からの API: cc.json に domain か serviceToken が無いので飛ばす");
    }
    try {
      const made = await api<{ id: string }>(local, "POST", "/api/sessions", { cwd: d.home, prompt: "reply with the single word ok" }, ctx.fetchFn);
      const s = await api<{ id: string; capabilities: { events: boolean }; kind: "node" }>(local, "GET", `/api/sessions/${made.id}`, undefined, ctx.fetchFn);
      const lines: string[] = [];
      const r = await readUntilResult(local, { ...s, cwd: d.home, state: "running", startedAt: 0, lastActivityAt: 0 } as never, 0, 90, (l) => lines.push(l), { fetchFn: ctx.fetchFn, pollMs: 1000 });
      await api(local, "DELETE", `/api/sessions/${made.id}`, undefined, ctx.fetchFn).catch(() => {});
      line(r.code === 0, `claude のセッション（ログイン）${r.code === 0 ? "" : `: ${lines.at(-1) ?? ""}`}`);
    } catch (e) {
      line(false, `claude のセッション: ${e instanceof Error ? e.message : String(e)}`);
    }
    return ng ? 1 : 0;
  }

  return async (words: string[], flags: Parsed["flags"], ctx: Ctx): Promise<number | undefined> => {
    const [cmd, sub, name] = words;
    switch (cmd) {
      case "setup": return setup(flags, ctx);
      case "node":
        if (sub === "add") return nodeAdd(name, flags, ctx);
        if (sub === "remove") {
          if (!name) throw new CliError(1, "node remove には <name> が要る");
          const cfg = needSetup(loadConfig(configPath));
          await removeNodeTunnel(d.cf, { name, hostname: `${name}.${cfg.domain}`, zone: cfg.zone });
          ctx.out(`トンネル cc-${name} と DNS を消した`);
          return 0;
        }
        throw new CliError(1, "node add <name> か node remove <name>");
      case "entry": {
        if (!sub) throw new CliError(1, "entry には <name> が要る");
        const cfg = needSetup(loadConfig(configPath));
        await setEntry(d.cf, { name: sub, entryHost: cfg.domain, port: num(flags.port, 4322), zone: cfg.zone });
        ctx.out(`入口 ${cfg.domain} を cc-${sub} に向けた`);
        return 0;
      }
      case "install": return install(flags, ctx);
      case "update": return update(ctx);
      case "uninstall": return uninstall(ctx);
      case "doctor": return doctor(ctx);
      case "serve": {
        const { start } = await import("../main");
        start(loadConfig(configPath));
        return new Promise(() => {}); // 止まるまで戻らない
      }
      default: return undefined;
    }
  };
}
