// 常駐。macOS は LaunchAgent、Linux は systemd --user。名前は names.ts（SERVICE_NAMING。改名前は LEGACY_SERVICE_NAMING）。node は bun で serve、tunnel は cloudflared の token-file
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Runner } from "../engine/agents";
import { ENTRY_SCRIPT, SERVICE_DESCRIPTION, SERVICE_NAMING, TUNNEL_TOKEN_FILE, type ServiceNaming } from "../names";

export type Paths = { home: string; appDir: string; configDir: string; logDir: string; bun: string; cloudflared: string; uid: number };
export type ServiceKind = "node" | "tunnel";
export type ServiceStatus = "running" | "stopped" | "unknown";
export interface ServiceManager {
  install(): Promise<void>;
  uninstall(): Promise<void>;
  restart(kind: ServiceKind): Promise<void>;
  status(): Promise<Record<ServiceKind, ServiceStatus>>;
}
export type Platform = "darwin" | "linux";
export const KINDS: ServiceKind[] = ["node", "tunnel"];
const label = (k: ServiceKind) => SERVICE_NAMING.label(k);
export const plistPathOf = (home: string, naming: ServiceNaming, k: ServiceKind) => join(home, "Library", "LaunchAgents", `${naming.label(k)}.plist`);
export const unitPathOf = (home: string, naming: ServiceNaming, k: ServiceKind) => join(home, ".config", "systemd", "user", `${naming.unit(k)}.service`);

const pathEnv = (p: Paths) => `${dirname(p.bun)}:${join(p.home, ".local", "bin")}:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin`;
function command(kind: ServiceKind, p: Paths): string[] {
  return kind === "node"
    ? [p.bun, "run", join(p.appDir, ...ENTRY_SCRIPT), "serve"]
    : [p.cloudflared, "tunnel", "run", "--token-file", join(p.configDir, TUNNEL_TOKEN_FILE)];
}
const xml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export function launchdPlist(kind: ServiceKind, p: Paths): string {
  const args = command(kind, p).map((a) => `    <string>${xml(a)}</string>`).join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${label(kind)}</string>
  <key>ProgramArguments</key>
  <array>
${args}
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>${xml(pathEnv(p))}</string>
    <key>HOME</key>
    <string>${xml(p.home)}</string>
  </dict>
  <key>WorkingDirectory</key>
  <string>${xml(p.home)}</string>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${xml(join(p.logDir, `${kind}.log`))}</string>
  <key>StandardErrorPath</key>
  <string>${xml(join(p.logDir, `${kind}.log`))}</string>
</dict>
</plist>
`;
}

export function systemdUnit(kind: ServiceKind, p: Paths): string {
  return `[Unit]
Description=${SERVICE_DESCRIPTION} ${kind}
After=network-online.target

[Service]
ExecStart=${command(kind, p).join(" ")}
Restart=always
RestartSec=3
Environment=PATH=${pathEnv(p)}
Environment=HOME=${p.home}
WorkingDirectory=${p.home}

[Install]
WantedBy=default.target
`;
}

export function serviceManager(
  platform: Platform,
  p: Paths,
  run: Runner,
  write: (path: string, text: string) => void = (path, text) => { mkdirSync(dirname(path), { recursive: true }); mkdirSync(p.logDir, { recursive: true }); writeFileSync(path, text); },
  remove: (path: string) => void = (path) => rmSync(path, { force: true }),
  naming: ServiceNaming = SERVICE_NAMING, // 改名前の常駐を外すときは LEGACY_SERVICE_NAMING
): ServiceManager {
  const label = (k: ServiceKind) => naming.label(k);
  const unitName = (k: ServiceKind) => naming.unit(k);
  const plistPath = (k: ServiceKind) => plistPathOf(p.home, naming, k);
  const unitPath = (k: ServiceKind) => unitPathOf(p.home, naming, k);
  if (platform === "darwin") {
    const domain = `gui/${p.uid}`;
    return {
      async install() {
        for (const k of KINDS) {
          write(plistPath(k), launchdPlist(k, p));
          await run(["launchctl", "bootout", `${domain}/${label(k)}`]); // 入っていなければ失敗するが無視
          const r = await run(["launchctl", "bootstrap", domain, plistPath(k)]);
          if (r.code !== 0) throw new Error(`launchctl bootstrap ${label(k)} failed: ${r.stdout}`);
        }
      },
      async uninstall() {
        for (const k of KINDS) { await run(["launchctl", "bootout", `${domain}/${label(k)}`]); remove(plistPath(k)); }
      },
      async restart(kind) { await run(["launchctl", "kickstart", "-k", `${domain}/${label(kind)}`]); },
      async status() {
        const out = {} as Record<ServiceKind, ServiceStatus>;
        for (const k of KINDS) {
          const r = await run(["launchctl", "print", `${domain}/${label(k)}`]);
          out[k] = r.code !== 0 ? "stopped" : /state = running/.test(r.stdout) ? "running" : "stopped";
        }
        return out;
      },
    };
  }
  return {
    async install() {
      for (const k of KINDS) write(unitPath(k), systemdUnit(k, p));
      await run(["systemctl", "--user", "daemon-reload"]);
      for (const k of KINDS) {
        const r = await run(["systemctl", "--user", "enable", "--now", unitName(k)]);
        if (r.code !== 0) throw new Error(`systemctl enable ${unitName(k)} failed: ${r.stdout}`);
      }
    },
    async uninstall() {
      for (const k of KINDS) { await run(["systemctl", "--user", "disable", "--now", unitName(k)]); remove(unitPath(k)); }
      await run(["systemctl", "--user", "daemon-reload"]);
    },
    async restart(kind) { await run(["systemctl", "--user", "restart", unitName(kind)]); },
    async status() {
      const out = {} as Record<ServiceKind, ServiceStatus>;
      for (const k of KINDS) {
        const r = await run(["systemctl", "--user", "is-active", unitName(k)]);
        out[k] = r.stdout.trim() === "active" ? "running" : r.code === 0 ? "unknown" : "stopped";
      }
      return out;
    },
  };
}
