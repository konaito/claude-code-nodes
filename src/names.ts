// 名前の正本。製品名、CLI 名、置き場、常駐、ヘッダ、配布物、Cloudflare の資源名、画面の localStorage のキーをここに集める。
// 名前を変えるときはここだけを直す。シェル（installer の文字列）と画面（index.html）も、ここから差し込む。
// LEGACY_* は 2026-11-11 の改名（cc → ccn）より前の名前。移行の間は新旧の両方を受け、ccn update と ccn install が旧から新へ移す
import { join } from "node:path";

export const PRODUCT_NAME = "Claude Code Nodes";   // 画面のタイトルと見出し
export const PACKAGE_NAME = "claude-code-nodes";   // package.json の name（試験で一致を確かめる）
export const CLI_NAME = "ccn";                     // macOS の /usr/bin/cc（C コンパイラ）と被らないように cc にはしない
export const OLD_CLI_NAMES = ["cc"];               // ~/.local/bin に残った改名前のリンクを消すためだけに使う

// 設定（公開値と秘密、0600）。CONFIG_ENV で設定ファイルを差し替えられる（手元で別ポートのノードを試すとき用）
export const CONFIG_ENV = "CCN_CONFIG";
export const LEGACY_CONFIG_ENV = "CC_CONFIG";
export const configDirOf = (home: string) => join(home, ".config", "ccn");
export const CONFIG_FILE = "ccn.json";
export const legacyConfigDirOf = (home: string) => join(home, ".config", "cc");
export const LEGACY_CONFIG_FILE = "cc.json";
export const TUNNEL_TOKEN_FILE = "tunnel.token";
export const SENDS_FILE = "sends.json";            // CLI の手元の控え（送った文の直前の seq）

// アプリの置き場。<appHome>/app が実行物、<appHome>/log が常駐のログ
export const appHomeOf = (home: string) => join(home, ".local", "share", "ccn");
export const legacyAppHomeOf = (home: string) => join(home, ".local", "share", "cc");
export const ENTRY_SCRIPT = ["src", "cli", "ccn.ts"]; // 実行物の中の CLI の入口（常駐とインストーラが呼ぶ）。旧の常駐が呼ぶ src/cli/cc.ts も残す

// 常駐。macOS は LaunchAgent のラベル、Linux は systemd --user のユニット名
export type ServiceNaming = { label: (kind: string) => string; unit: (kind: string) => string };
export const launchdLabel = (kind: string) => `jp.fybe.ccn.${kind}`;
export const systemdUnitName = (kind: string) => `ccn-${kind}`;
export const SERVICE_NAMING: ServiceNaming = { label: launchdLabel, unit: systemdUnitName };
export const LEGACY_SERVICE_NAMING: ServiceNaming = { label: (k) => `jp.fybe.cc.${k}`, unit: (k) => `cc-${k}` };
export const SERVICE_DESCRIPTION = PRODUCT_NAME;   // systemd の Description の頭

// ノード間の呼び手のヘッダ（仕様 1.3）。送るときは新旧の両方を付け、受けるときは新を先に見る
export const HEADER_FROM = "x-ccn-from";
export const HEADER_VIA = "x-ccn-via";
export const LEGACY_HEADER_FROM = "x-cc-from";
export const LEGACY_HEADER_VIA = "x-cc-via";

// 配布物。入口ノードが /install/<BUNDLE_FILE> で自分のソースを配る。旧のノードの ccn update は旧のパスを取りに来る
export const BUNDLE_FILE = "ccn.tar.gz";
export const BUNDLE_PATH = `/install/${BUNDLE_FILE}`;
export const LEGACY_BUNDLE_PATH = "/install/cc.tar.gz";

// Cloudflare。登録簿はこの頭で始まるトンネル。ノードのホスト名はトンネル名と同じ <prefix><name>.<zone>
export const TUNNEL_PREFIX = "ccn-";
export const LEGACY_TUNNEL_PREFIX = "cc-";
export const ACCESS_APP = "ccn";                   // 人の email とノード用サービストークンを通す Access アプリ
export const BYPASS_APP = "ccn-install";           // <host>/install だけ Access を外すアプリ
export const SERVICE_TOKEN = "ccn-node";           // ノード用サービストークン
export const LEGACY_ACCESS_APP = "cc";
export const LEGACY_BYPASS_APP = "cc-install";
export const LEGACY_SERVICE_TOKEN = "cc-node";
export const ENTRY_DOMAIN = "ccn.fybe.jp";         // 入口の既定のホスト名

// MCP の口と、公開する説明書。/skill.md の正本は <appRoot>/skills/<PUBLIC_SKILL_NAME>/SKILL.md（束に入り、利用者の機械にはリンクしない）
export const MCP_PATH = "/mcp";
export const MCP_SERVER_NAME = "ccn";              // serverInfo の名前。/skill.md の claude mcp add の例もこの名前にそろえる
export const SKILL_MD_PATH = "/skill.md";
export const PUBLIC_SKILL_NAME = "claude-code-nodes"; // agentskills の name。親ディレクトリ名と同じにする
export const PUBLIC_PATHS = ["/install", SKILL_MD_PATH]; // 認証なしで読める道。Bypass アプリはホストごとにこの全部を外す

// 利用者の機械に配るスキルと child.md
export const SKILL_NAME = "ccn";
export const childMdDirOf = (home: string) => configDirOf(home);
export const LEGACY_SKILL_NAME = "session-inbox";
export const legacyChildMdDirOf = (home: string) => join(home, ".config", "session-inbox");

// 画面の localStorage のキーの頭
export const STORAGE_PREFIX = "ccn.";
export const LEGACY_STORAGE_PREFIX = "cc.";
