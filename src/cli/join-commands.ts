// ccn の参加側の命令。setup（1回だけの準備）、node add/remove、entry、install、update、uninstall、doctor、serve。cf、常駐、端末、ファイルは deps の裏
import { chmodSync, cpSync, existsSync, lstatSync, mkdirSync, readlinkSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { entryOf, hostFor, loadConfig, nodeHost, resolveConfigPath, saveConfig, type Config } from "../config";
import type { Runner } from "../engine/agents";
import { addNodeHost, createNodeTunnel, ensureAccessApp, ensureBypassApp, ensureServiceToken, nodeTunnelToken, removeNodeTunnel, renameNodeTunnel, setEntry, type CfRunner } from "../join/cf";
import { configFromToken, decodeJoinToken, encodeJoinToken, JoinTokenError, type JoinToken } from "../join/token";
import { plistPathOf, unitPathOf, type Paths, type Platform, type ServiceManager } from "../join/services";
import { withCrossSessionInbound, SettingsError } from "../join/settings";
import { linkSkill, realFs } from "../join/skill-links";
import { BUNDLE_PATHS } from "../join/bundle";
import { CliError, clientFor, api } from "./client";
import { readUntilResult } from "./read";
import type { Ctx } from "./commands";
import type { Parsed } from "./args";
import { ACCESS_APP, appHomeOf, BUNDLE_PATH, BYPASS_APP, CLI_NAME, CONFIG_FILE, ENTRY_DOMAIN, launchdLabel, LEGACY_ACCESS_APP, LEGACY_BUNDLE_PATH, LEGACY_BYPASS_APP, LEGACY_SERVICE_TOKEN, LEGACY_TUNNEL_PREFIX, legacyAppHomeOf, OLD_CLI_NAMES, SERVICE_NAMING, SERVICE_TOKEN, systemdUnitName, TUNNEL_PREFIX, TUNNEL_TOKEN_FILE } from "../names";
import { dropLegacyAppHome, dropLegacyServices, dropLegacySkill, hasLegacy, moveLegacyConfig, realMigrateFs, type MigrateFs } from "../join/migrate";

export type JoinDeps = {
  cf: CfRunner;
  services: (platform: Platform, p: Paths) => ServiceManager;
  legacyServices: (platform: Platform, p: Paths) => ServiceManager; // 改名前の常駐（jp.fybe.cc.*、cc-*）を外すため
  migrateFs?: MigrateFs;
  platform: Platform;
  home: string; configDir: string; appDir: string; bunPath: string; cloudflaredPath: string; uid: number;
  configFile?: string; // CCN_CONFIG（旧 CC_CONFIG）で渡された設定ファイル。あれば読むのも書くのもこれ
  tty: (prompt: string) => Promise<string>;   // /dev/tty から1行
  ttyWrite: (text: string) => void;           // /dev/tty へ
  clipboard?: (text: string) => Promise<boolean>;
  run: Runner;
  now: () => Date;
};
export const TESTED_CLAUDE = "2.1.318";
const DEFAULTS = { email: "ceo@fybe.jp", domain: ENTRY_DOMAIN, zone: "fybe.jp", teamDomain: "fybejp.cloudflareaccess.com", accountId: "9b67e2ec0e2cf3359289e1fc860d3777" };
const str = (v: string | true | undefined) => (typeof v === "string" ? v : undefined);
const num = (v: string | true | undefined, d: number) => { const n = Number(str(v)); return str(v) !== undefined && Number.isFinite(n) ? n : d; };

export function joinCommands(d: JoinDeps) {
  // 新の設定が無く旧（~/.config/cc/cc.json）があれば旧を読む。書くのはいつも新
  const configPath = d.configFile ?? join(d.configDir, CONFIG_FILE);
  const readPath = () => d.configFile ?? resolveConfigPath(d.home, d.configDir);
  const paths = (): Paths => ({ home: d.home, appDir: d.appDir, configDir: d.configDir, logDir: join(appHomeOf(d.home), "log"), bun: d.bunPath, cloudflared: d.cloudflaredPath, uid: d.uid });
  const services = () => d.services(d.platform, paths());
  const mig = (ctx: Ctx) => ({ home: d.home, platform: d.platform, fs: d.migrateFs ?? realMigrateFs, now: d.now(), out: ctx.out });
  // 旧の常駐を外してから新の常駐を入れる。外してから入れるまでの間を短くするため、ファイルの移動を済ませてから呼ぶ。
  // ノードが立てたセッションの中から呼ぶと、旧の常駐を外したところで自分も止まるので、端末か SSH から実行する
  async function swapServices(ctx: Ctx): Promise<boolean> {
    const dropped = await dropLegacyServices(mig(ctx), d.legacyServices(d.platform, paths()));
    if (dropped) await services().install();
    return dropped;
  }
  const needSetup = (cfg: Config): Required<Pick<Config, "domain" | "zone" | "teamDomain" | "aud" | "accountId" | "serviceToken" | "cfApiToken">> & Config => {
    for (const k of ["domain", "zone", "teamDomain", "aud", "accountId", "serviceToken", "cfApiToken"] as const) if (!cfg[k]) throw new CliError(1, `${CONFIG_FILE} に ${k} が無い。先に ${CLI_NAME} setup を実行する`);
    return cfg as ReturnType<typeof needSetup>;
  };

  async function setup(flags: Parsed["flags"], ctx: Ctx): Promise<number> {
    const hosts = (str(flags.hosts) ?? "").split(",").map((s) => s.trim()).filter(Boolean);
    if (!hosts.length) throw new CliError(1, `--hosts <a,b> が要る（例: '${TUNNEL_PREFIX}*.fybe.jp,${ENTRY_DOMAIN}'）`);
    const had = existsSync(readPath());
    const cfg = loadConfig(readPath());
    // 改名前の名前（cc-node、cc、cc-install）の資源があればそれを使う。Access アプリは新しい名前と --hosts で上書きするので aud は変わらない
    const tok = await ensureServiceToken(d.cf, { name: SERVICE_TOKEN, legacyNames: [LEGACY_SERVICE_TOKEN], duration: "8760h" });
    let serviceToken: Config["serviceToken"];
    if (tok.clientSecret) serviceToken = { clientId: tok.clientId, clientSecret: tok.clientSecret };
    else if (cfg.serviceToken?.clientId === tok.clientId) serviceToken = cfg.serviceToken;
    else throw new CliError(1, `サービストークン ${SERVICE_TOKEN}（${tok.id}）は既にあるが secret が手元に無い。cf zero-trust access service-tokens rotate ${tok.id} で取り直すか、消してからやり直す`);
    const email = str(flags.email) ?? DEFAULTS.email;
    const app = await ensureAccessApp(d.cf, { name: ACCESS_APP, legacyNames: [LEGACY_ACCESS_APP], hosts, sessionDuration: "720h", email, serviceTokenId: tok.id });
    const bypass = await ensureBypassApp(d.cf, { name: BYPASS_APP, legacyNames: [LEGACY_BYPASS_APP], hosts });
    // CF API トークンは手元の設定、無ければ標準入力（--cf-token-stdin。pbpaste | ... 用）、無ければ /dev/tty。argv と環境変数には出さない
    const cfApiToken = cfg.cfApiToken ?? (flags["cf-token-stdin"] ? await ctx.stdin() : await d.tty("CF API トークン（Account / Cloudflare Tunnel / Read）: ")).trim();
    if (!cfApiToken) throw new CliError(1, "CF API トークンが空");
    const next: Config = {
      name: str(flags.name) ?? cfg.name, port: num(flags.port, cfg.port), roots: had ? cfg.roots : [d.home],
      domain: str(flags.domain) ?? cfg.domain ?? DEFAULTS.domain, zone: str(flags.zone) ?? cfg.zone ?? DEFAULTS.zone,
      teamDomain: str(flags["team-domain"]) ?? cfg.teamDomain ?? DEFAULTS.teamDomain, aud: app.aud,
      accountId: str(flags["account-id"]) ?? cfg.accountId ?? DEFAULTS.accountId, serviceToken, cfApiToken,
    };
    if (cfg.entry) next.entry = cfg.entry;
    saveConfig(next, configPath);
    ctx.out(`Access アプリ ${ACCESS_APP}: ${app.id} (aud ${app.aud})`);
    ctx.out(`Bypass アプリ ${BYPASS_APP}: ${bypass.id}`);
    ctx.out(`サービストークン ${tok.name}: ${tok.id}`);
    ctx.out(`保存した: ${configPath}`);
    return 0;
  }

  // node add は作る。node token は既にあるトンネルのトークンを読み直して参加トークンを出し直す（クリップボードが上書きされたとき用）
  async function nodeAdd(name: string | undefined, flags: Parsed["flags"], ctx: Ctx, reissue = false): Promise<number> {
    if (!name) throw new CliError(1, `node ${reissue ? "token" : "add"} には <name> が要る`);
    const cfg = needSetup(loadConfig(readPath()));
    const port = num(flags.port, 4322);
    const hostname = nodeHost(name, cfg);
    const entry = entryOf(cfg)!;
    const { tunnelId, token } = reissue ? await nodeTunnelToken(d.cf, { name }) : await createNodeTunnel(d.cf, { name, hostname, port, zone: cfg.zone });
    const jt: JoinToken = { v: 1, name, port, domain: cfg.domain, zone: cfg.zone, teamDomain: cfg.teamDomain, aud: cfg.aud, accountId: cfg.accountId, entry, tunnelToken: token, serviceToken: cfg.serviceToken, cfApiToken: cfg.cfApiToken };
    const enc = encodeJoinToken(jt);
    const to = str(flags.to);
    if (to) {
      // ファイルに出す（0600）。scp やパイプで運ぶとき用。argv に出るのはパスだけ
      writeFileSync(to, enc + "\n", { mode: 0o600 });
      chmodSync(to, 0o600);
      ctx.out(`参加トークンを ${to} に書いた（0600。貼り終えたら消す）`);
    } else if (d.clipboard && (await d.clipboard(enc))) ctx.out("参加トークンをクリップボードに入れた（表示はしない）");
    else { d.ttyWrite(enc + "\n"); ctx.out("参加トークンを端末に出した"); }
    ctx.out(`トンネル ${TUNNEL_PREFIX}${name} (${tunnelId})、ホスト名 ${hostname} → 127.0.0.1:${port}`);
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
    // 改名前の機械なら、旧の設定（sends.json など）を新の置き場に移してから、参加トークンの設定で上書きする
    moveLegacyConfig(mig(ctx));
    saveConfig(cfg, configPath);
    const tokenPath = join(d.configDir, TUNNEL_TOKEN_FILE);
    writeFileSync(tokenPath, token.tunnelToken, { mode: 0o600 });
    chmodSync(tokenPath, 0o600);
    const from = str(flags.from);
    if (from) {
      // ブートストラップ用。配布物と同じ範囲（BUNDLE_PATHS）だけ写し、依存を入れる
      rmSync(d.appDir, { recursive: true, force: true });
      mkdirSync(d.appDir, { recursive: true });
      for (const rel of BUNDLE_PATHS) if (existsSync(join(from, rel))) cpSync(join(from, rel), join(d.appDir, rel), { recursive: true });
      const inst = await d.run([d.bunPath, "install", "--frozen-lockfile", "--production", "--cwd", d.appDir]);
      if (inst.code !== 0) throw new CliError(1, `bun install が失敗した: ${inst.stdout.slice(0, 300)}`);
    }
    realFs.writeText(settingsPath, settingsNext);
    linkSkill({ home: d.home, appDir: d.appDir, configDir: d.configDir, now: d.now() }, realFs);
    dropLegacySkill(mig(ctx));
    await linkBin(ctx);
    await dropLegacyServices(mig(ctx), d.legacyServices(d.platform, paths())); // 同じポートに旧と新が並ばないように、旧を先に外す
    await services().install();
    dropLegacyAppHome(mig(ctx));
    ctx.out(`設定 ${configPath}、常駐を入れた（${d.platform === "darwin" ? `LaunchAgent ${launchdLabel("*")}` : `systemd --user ${systemdUnitName("*")}`}）`);
    await doctor(ctx);
    ctx.out(`done: 実行物は ${binOf()}（${CLI_NAME}）`);
    return 0;
  }

  const binOf = () => join(d.appDir, "bin", CLI_NAME);
  const localBin = (name: string) => join(d.home, ".local", "bin", name);
  // 改名前の ~/.local/bin/<OLD_CLI_NAMES> のうち、実行物（新か旧の置き場）を指すリンクだけを消す。他人の cc（C コンパイラなど）には触らない
  function dropOldLinks() {
    const appDirs = [d.appDir, join(legacyAppHomeOf(d.home), "app")];
    for (const name of OLD_CLI_NAMES) {
      const p = localBin(name);
      try { if (lstatSync(p).isSymbolicLink() && appDirs.some((a) => readlinkSync(p) === join(a, "bin", name))) rmSync(p, { force: true }); } catch { /* 無い */ }
    }
  }

  // ~/.local/bin/<CLI_NAME> → <appDir>/bin/<CLI_NAME>。PATH に別の同名の命令があれば置かずに案内する
  async function linkBin(ctx: Ctx) {
    dropOldLinks();
    const link = localBin(CLI_NAME);
    const other = await d.run(["sh", "-c", `command -v ${CLI_NAME}`]);
    const found = other.code === 0 ? other.stdout.trim() : "";
    if (found && found !== link) { ctx.out(`PATH に ${found} があるので ${link} は置かない。使うときは ${binOf()} を呼ぶか alias を作る`); return; }
    mkdirSync(join(d.home, ".local", "bin"), { recursive: true });
    rmSync(link, { force: true });
    symlinkSync(binOf(), link);
  }

  // 入口の束（または --from の checkout）を app.new に広げて依存を入れ、app と入れ替える。リンクと child.md も新しい版に合わせる。
  // 改名前の機械なら、旧の設定、スキル、~/.config/session-inbox、常駐、アプリの置き場をここで移す（旧のコードが走る1回目では動かない）。
  // --entry <url> は入口を差し替えて設定に書く（入口を ccn.fybe.jp に移した後に使う）
  async function update(flags: Parsed["flags"], ctx: Ctx): Promise<number> {
    const entryFlag = str(flags.entry);
    if (entryFlag !== undefined && !/^https?:\/\/[A-Za-z0-9.:[\]-]+$/.test(entryFlag)) throw new CliError(1, `--entry は https://<ホスト名> の形で渡す: ${entryFlag}`);
    const newDir = `${d.appDir}.new`;
    const oldDir = `${d.appDir}.old`;
    rmSync(newDir, { recursive: true, force: true });
    mkdirSync(newDir, { recursive: true });
    const from = str(flags.from);
    if (from) {
      for (const rel of BUNDLE_PATHS) if (existsSync(join(from, rel))) cpSync(join(from, rel), join(newDir, rel), { recursive: true });
    } else {
      const entry = entryFlag ?? entryOf(loadConfig(readPath()));
      if (!entry) throw new CliError(1, `${CONFIG_FILE} に entry も domain も無い`);
      // 入口がまだ更新していないノードなら、新のパスは 404 なので旧のパスから取る
      let r = await ctx.fetchFn(`${entry}${BUNDLE_PATH}`);
      if (r.status === 404) { await r.body?.cancel().catch(() => {}); r = await ctx.fetchFn(`${entry}${LEGACY_BUNDLE_PATH}`); }
      if (!r.ok) throw new CliError(1, `${entry}${BUNDLE_PATH} → ${r.status}`);
      const tgz = `${d.appDir}.new.tgz`;
      writeFileSync(tgz, new Uint8Array(await r.arrayBuffer()));
      const tar = Bun.spawn(["tar", "xzf", tgz, "-C", newDir], { stdout: "ignore", stderr: "pipe" });
      const code = await tar.exited;
      rmSync(tgz, { force: true });
      if (code !== 0) throw new CliError(1, `tar が失敗した: ${await new Response(tar.stderr).text()}`);
    }
    const inst = await d.run([d.bunPath, "install", "--frozen-lockfile", "--production", "--cwd", newDir]);
    if (inst.code !== 0) throw new CliError(1, `bun install が失敗した: ${inst.stdout.slice(0, 300)}`);
    const m = mig(ctx);
    moveLegacyConfig(m);
    if (entryFlag !== undefined) {
      const cfg = loadConfig(readPath());
      saveConfig({ ...cfg, entry: entryFlag, domain: new URL(entryFlag).hostname }, configPath);
      ctx.out(`入口を ${entryFlag} にした`);
    }
    rmSync(oldDir, { recursive: true, force: true });
    if (existsSync(d.appDir)) renameSync(d.appDir, oldDir);
    renameSync(newDir, d.appDir);
    rmSync(oldDir, { recursive: true, force: true });
    linkSkill({ home: d.home, appDir: d.appDir, configDir: d.configDir, now: d.now() }, realFs);
    dropLegacySkill(m);
    await linkBin(ctx);
    // 常駐の入れ替えは最後。旧があれば外して新を入れ、新が無ければ入れ、あれば node を再起動する
    if (await swapServices(ctx)) ctx.out("旧の常駐を外し、新の常駐を入れた");
    else if (!hasServiceFiles()) { await services().install(); ctx.out("常駐を入れた"); }
    else await services().restart("node");
    dropLegacyAppHome(m);
    ctx.out(`更新した: ${d.appDir}。node を再起動した。実行物は ${CLI_NAME}`);
    return 0;
  }
  const hasServiceFiles = () => (d.migrateFs ?? realMigrateFs).exists(d.platform === "darwin" ? plistPathOf(d.home, SERVICE_NAMING, "node") : unitPathOf(d.home, SERVICE_NAMING, "node"));

  async function uninstall(ctx: Ctx): Promise<number> {
    await services().uninstall();
    await dropLegacyServices(mig(ctx), d.legacyServices(d.platform, paths()));
    rmSync(appHomeOf(d.home), { recursive: true, force: true });
    dropLegacyAppHome(mig(ctx));
    // 設定の置き場は消すが、移行で退避した legacy-session-inbox-* は残す
    const kept: string[] = [];
    for (const name of (d.migrateFs ?? realMigrateFs).list(d.configDir)) {
      if (name.startsWith("legacy-")) kept.push(name);
      else rmSync(join(d.configDir, name), { recursive: true, force: true });
    }
    if (!kept.length) rmSync(d.configDir, { recursive: true, force: true });
    rmSync(localBin(CLI_NAME), { force: true });
    dropOldLinks();
    ctx.out(`常駐と ${appHomeOf(d.home)} と ${d.configDir} を消した${kept.length ? `（${kept.join("、")} は残した）` : ""}。~/.claude/settings.json の crossSessionInbound とスキルのリンクは残している`);
    return 0;
  }

  async function doctor(ctx: Ctx): Promise<number> {
    const cfg = loadConfig(readPath());
    if (hasLegacy(mig(ctx))) ctx.out(`-- 改名前（cc）の常駐か置き場が残っている。端末か SSH から ${CLI_NAME} update を実行すると移す`);
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
    if ((cfg.zone || cfg.domain) && cfg.serviceToken) {
      // clientFor は自分の名前だと 127.0.0.1 に向くので、外からの経路（Access → トンネル → ノード）は URL を直接組む
      const url = `https://${nodeHost(cfg.name, cfg)}/api/host`;
      const r = await ctx.fetchFn(url, { headers: { "cf-access-client-id": cfg.serviceToken.clientId, "cf-access-client-secret": cfg.serviceToken.clientSecret } }).catch(() => undefined);
      line(!!(r && r.ok), `外からの API ${url}${r ? ` → ${r.status}` : "（繋がらない）"}`);
    } else {
      ctx.out(`-- 外からの API: ${CONFIG_FILE} に domain か serviceToken が無いので飛ばす`);
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
        if (sub === "token") return nodeAdd(name, flags, ctx, true);
        if (sub === "remove") {
          if (!name) throw new CliError(1, "node remove には <name> が要る");
          const cfg = needSetup(loadConfig(readPath()));
          if (flags.legacy) {
            // 移行が済んで旧のホスト名（cc-<name>）を片付けるとき。トンネルは消さない（改名前ならそれが機械の動いているトンネル）
            const hostname = hostFor(LEGACY_TUNNEL_PREFIX, name, cfg.zone);
            await removeNodeTunnel(d.cf, { tunnelName: `${LEGACY_TUNNEL_PREFIX}${name}`, hostname, zone: cfg.zone, dnsOnly: true });
            ctx.out(`旧のホスト名 ${hostname} の DNS を消した（トンネルは残した）`);
            return 0;
          }
          await removeNodeTunnel(d.cf, { tunnelName: `${TUNNEL_PREFIX}${name}`, hostname: nodeHost(name, cfg), zone: cfg.zone });
          ctx.out(`トンネル ${TUNNEL_PREFIX}${name} と DNS を消した`);
          return 0;
        }
        if (sub === "migrate") {
          // 改名前のノード（トンネル cc-<name>）に新のホスト名 ccn-<name> を足す（ingress と DNS。旧のホスト名は残す）。
          // --rename はトンネルの名前も ccn-<name> に変える。トンネルの id とトークンは変わらないので、機械の側は何もしなくてよい
          if (!name) throw new CliError(1, "node migrate には <name> が要る");
          const cfg = needSetup(loadConfig(readPath()));
          const hostname = nodeHost(name, cfg);
          const added = await addNodeHost(d.cf, { name, hostname, zone: cfg.zone });
          ctx.out(`${hostname} を ingress に${added.ingress ? "足した" : "既に持っている"}。DNS は${added.dns ? "作った" : "既にある"}`);
          if (flags.rename) {
            const r = await renameNodeTunnel(d.cf, { name });
            ctx.out(r.renamed ? `トンネル ${r.from} を ${TUNNEL_PREFIX}${name} に改名した` : `トンネルは既に ${TUNNEL_PREFIX}${name}`);
          }
          return 0;
        }
        throw new CliError(1, "node add <name> か node token <name> か node remove <name> [--legacy] か node migrate <name> [--rename]");
      case "entry": {
        // --host を省くと設定の domain。改名で入口を ccn.fybe.jp に移すときは --host ccn.fybe.jp
        if (!sub) throw new CliError(1, "entry には <name> が要る");
        const cfg = needSetup(loadConfig(readPath()));
        const host = str(flags.host) ?? cfg.domain;
        await setEntry(d.cf, { name: sub, entryHost: host, port: num(flags.port, 4322), zone: cfg.zone });
        ctx.out(`入口 ${host} を ${sub} のトンネルに向けた`);
        return 0;
      }
      case "install": return install(flags, ctx);
      case "update": return update(flags, ctx);
      case "uninstall": return uninstall(ctx);
      case "doctor": return doctor(ctx);
      case "serve": {
        const { start } = await import("../main");
        start(loadConfig(readPath()));
        return new Promise(() => {}); // 止まるまで戻らない
      }
      default: return undefined;
    }
  };
}
