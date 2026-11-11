// 名前の正本。製品名、CLI 名、置き場、常駐、ヘッダ、配布物、Cloudflare の資源名、画面の localStorage のキーをここに集める。
// 名前を変えるときはここだけを直す。シェル（installer の文字列）と画面（index.html）も、ここから差し込む
import { join } from "node:path";

export const PRODUCT_NAME = "cc";                  // 画面のタイトルと見出し
export const PACKAGE_NAME = "cc-web";              // package.json の name（試験で一致を確かめる）
export const CLI_NAME = "ccn";                     // macOS の /usr/bin/cc（C コンパイラ）と被らないように cc にはしない
export const OLD_CLI_NAMES = ["cc"];               // ~/.local/bin に残った改名前のリンクを消すためだけに使う

// 設定（公開値と秘密、0600）。CONFIG_ENV で設定ファイルを差し替えられる（手元で別ポートのノードを試すとき用）
export const CONFIG_ENV = "CC_CONFIG";
export const configDirOf = (home: string) => join(home, ".config", "cc");
export const CONFIG_FILE = "cc.json";
export const TUNNEL_TOKEN_FILE = "tunnel.token";
export const SENDS_FILE = "sends.json";            // CLI の手元の控え（送った文の直前の seq）

// アプリの置き場。<appHome>/app が実行物、<appHome>/log が常駐のログ
export const appHomeOf = (home: string) => join(home, ".local", "share", "cc");
export const ENTRY_SCRIPT = ["src", "cli", "cc.ts"]; // 実行物の中の CLI の入口（常駐とインストーラが呼ぶ）

// 常駐。macOS は LaunchAgent のラベル、Linux は systemd --user のユニット名
export const launchdLabel = (kind: string) => `jp.fybe.cc.${kind}`;
export const systemdUnitName = (kind: string) => `cc-${kind}`;
export const SERVICE_DESCRIPTION = "cc";           // systemd の Description の頭

// ノード間の呼び手のヘッダ（仕様 1.3）
export const HEADER_FROM = "x-cc-from";
export const HEADER_VIA = "x-cc-via";

// 配布物。入口ノードが /install/<BUNDLE_FILE> で自分のソースを配る
export const BUNDLE_FILE = "cc.tar.gz";
export const BUNDLE_PATH = `/install/${BUNDLE_FILE}`;

// Cloudflare。登録簿はこの頭で始まるトンネル。ノードのホスト名はトンネル名と同じ <TUNNEL_PREFIX><name>.<zone>
export const TUNNEL_PREFIX = "cc-";
export const ACCESS_APP = "cc";                    // 人の email とノード用サービストークンを通す Access アプリ
export const BYPASS_APP = "cc-install";            // <host>/install だけ Access を外すアプリ
export const SERVICE_TOKEN = "cc-node";            // ノード用サービストークン
export const ENTRY_DOMAIN = "cc.fybe.jp";          // 入口の既定のホスト名

// 利用者の機械に配るスキルと child.md
export const SKILL_NAME = "session-inbox";
export const childMdDirOf = (home: string) => join(home, ".config", "session-inbox");

// 画面の localStorage のキーの頭
export const STORAGE_PREFIX = "cc.";
