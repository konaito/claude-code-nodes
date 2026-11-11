// 改名（cc → ccn、2026-11-11）の移行。旧の常駐、設定、アプリの置き場、スキルのリンク、~/.config/session-inbox を新へ移すか片付ける。
// ccn update と ccn install が呼ぶ。旧のコードが実行する1回目の ccn update では動かず、新しいコードが動く2回目で動く。
// 何度呼んでも同じ結果になるようにする（済んだものは飛ばす）
import { cpSync, lstatSync, mkdirSync, readdirSync, renameSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { CONFIG_FILE, configDirOf, LEGACY_CONFIG_FILE, LEGACY_SERVICE_NAMING, LEGACY_SKILL_NAME, legacyAppHomeOf, legacyChildMdDirOf, legacyConfigDirOf } from "../names";
import { KINDS, plistPathOf, unitPathOf, type Platform, type ServiceManager } from "./services";

export type MigrateFs = {
  exists(p: string): boolean;     // symlink はリンク先を見ずに true
  isSymlink(p: string): boolean;
  list(p: string): string[];
  mkdir(p: string): void;         // 0700
  rename(from: string, to: string): void;
  copyDir(from: string, to: string): void;
  rm(p: string): void;            // symlink はリンクだけを消す
};

export const realMigrateFs: MigrateFs = {
  exists: (p) => { try { lstatSync(p); return true; } catch { return false; } },
  isSymlink: (p) => { try { return lstatSync(p).isSymbolicLink(); } catch { return false; } },
  list: (p) => { try { return readdirSync(p); } catch { return []; } },
  mkdir: (p) => mkdirSync(p, { recursive: true, mode: 0o700 }),
  rename: (from, to) => renameSync(from, to),
  copyDir: (from, to) => { mkdirSync(dirname(to), { recursive: true }); cpSync(from, to, { recursive: true, preserveTimestamps: true }); },
  rm: (p) => rmSync(p, { recursive: true, force: true }),
};

export type MigrateDeps = { home: string; platform: Platform; fs: MigrateFs; now: Date; out: (line: string) => void };

const day = (d: Date) => `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}`;

// 旧の常駐のファイル（plist か unit）が1つでもあるか
export function hasLegacyServices(d: Pick<MigrateDeps, "home" | "platform" | "fs">): boolean {
  return KINDS.some((k) => d.fs.exists(d.platform === "darwin" ? plistPathOf(d.home, LEGACY_SERVICE_NAMING, k) : unitPathOf(d.home, LEGACY_SERVICE_NAMING, k)));
}

// 旧の常駐を外す（launchctl bootout か systemctl disable --now、ファイルも消す）。新の常駐を入れる直前に呼ぶ。同じポートに2つ常駐させないため
export async function dropLegacyServices(d: MigrateDeps, legacy: ServiceManager): Promise<boolean> {
  if (!hasLegacyServices(d)) return false;
  await legacy.uninstall();
  d.out("旧の常駐を外した");
  return true;
}

// ~/.config/cc を ~/.config/ccn に移す。cc.json は ccn.json にする。新の設定が既にあれば何もしない
export function moveLegacyConfig(d: MigrateDeps): void {
  const oldDir = legacyConfigDirOf(d.home);
  const newDir = configDirOf(d.home);
  if (!d.fs.exists(oldDir)) return;
  if (d.fs.exists(join(newDir, CONFIG_FILE))) { d.out(`旧の設定 ${oldDir} は残した（${join(newDir, CONFIG_FILE)} が既にある）`); return; }
  d.fs.mkdir(newDir);
  for (const name of d.fs.list(oldDir)) {
    const to = join(newDir, name === LEGACY_CONFIG_FILE ? CONFIG_FILE : name);
    if (!d.fs.exists(to)) d.fs.rename(join(oldDir, name), to);
  }
  if (d.fs.list(oldDir).length === 0) d.fs.rm(oldDir);
  d.out(`設定を ${oldDir} から ${newDir} に移した`);
}

// 旧のスキルのリンク（session-inbox）を消し、~/.config/session-inbox を ~/.config/ccn/legacy-session-inbox-<日付> に退避してから消す
export function dropLegacySkill(d: MigrateDeps): void {
  for (const p of [join(d.home, ".agents", "skills", LEGACY_SKILL_NAME), join(d.home, ".claude", "skills", LEGACY_SKILL_NAME)]) {
    if (d.fs.isSymlink(p)) { d.fs.rm(p); d.out(`旧のスキルのリンク ${p} を消した`); }
    else if (d.fs.exists(p)) d.out(`${p} はリンクではないので残した`);
  }
  const old = legacyChildMdDirOf(d.home);
  if (!d.fs.exists(old)) return;
  let backup = join(configDirOf(d.home), `legacy-session-inbox-${day(d.now)}`);
  for (let i = 2; d.fs.exists(backup); i++) backup = join(configDirOf(d.home), `legacy-session-inbox-${day(d.now)}-${i}`);
  d.fs.copyDir(old, backup);
  d.fs.rm(old);
  d.out(`${old} を ${backup} に退避して消した`);
}

// 旧のアプリの置き場（~/.local/share/cc）を消す。新の常駐が動いてから最後に呼ぶ
export function dropLegacyAppHome(d: MigrateDeps): void {
  const old = legacyAppHomeOf(d.home);
  if (!d.fs.exists(old)) return;
  d.fs.rm(old);
  d.out(`旧のアプリの置き場 ${old} を消した`);
}

// 旧の名前のものが1つでも残っているか（移行が要るか）
export function hasLegacy(d: Pick<MigrateDeps, "home" | "platform" | "fs">): boolean {
  return hasLegacyServices(d) || d.fs.exists(legacyConfigDirOf(d.home)) || d.fs.exists(legacyAppHomeOf(d.home)) || d.fs.exists(legacyChildMdDirOf(d.home))
    || d.fs.isSymlink(join(d.home, ".agents", "skills", LEGACY_SKILL_NAME)) || d.fs.isSymlink(join(d.home, ".claude", "skills", LEGACY_SKILL_NAME));
}

