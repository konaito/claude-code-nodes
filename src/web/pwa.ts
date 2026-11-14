// ホーム画面に追加するための manifest、アイコン、Service Worker。入口と各ノードは別のオリジンなので、どれもルート相対で書き、ホストごとに別のアプリとして入る
import { join } from "node:path";
import { CLI_NAME, PRODUCT_NAME, PWA_PATH } from "../names";

const ICONS = { "icon-180.png": 180, "icon-192.png": 192, "icon-512.png": 512 } as const;
const THEME = "#ffffff";

// ホーム画面の名前。ccn-<name>.fybe.jp ならホスト名の頭（ccn-vm など）にして、入口と各ノードを見分けられるようにする
function shortNameOf(host: string): string {
  const label = host.split(":")[0]!.split(".")[0]!;
  return /^[a-z][a-z0-9-]*$/.test(label) && host.includes(".") ? label : CLI_NAME;
}

export function manifest(host: string) {
  const icon = (file: keyof typeof ICONS, purpose: string) => ({ src: `${PWA_PATH}/${file}`, sizes: `${ICONS[file]}x${ICONS[file]}`, type: "image/png", purpose });
  return {
    id: "/",
    name: PRODUCT_NAME,
    short_name: shortNameOf(host),
    start_url: "/",
    scope: "/",
    display: "standalone",
    theme_color: THEME,
    background_color: THEME,
    lang: "ja",
    icons: [icon("icon-192.png", "any"), icon("icon-512.png", "any"), icon("icon-512.png", "maskable")],
  };
}

// /pwa/ の下の道。無ければ null
export async function pwaAsset(path: string, host: string): Promise<Response | null> {
  const name = path.slice(PWA_PATH.length + 1);
  if (name === "manifest.webmanifest") {
    return new Response(JSON.stringify(manifest(host)), { headers: { "content-type": "application/manifest+json; charset=utf-8", "cache-control": "no-cache" } });
  }
  if (name in ICONS) {
    return new Response(Bun.file(join(import.meta.dir, "pwa", name)), { headers: { "content-type": "image/png", "cache-control": "public, max-age=3600" } });
  }
  return null;
}

// Android の Chrome がインストールの条件に見る最小の Service Worker。キャッシュを持たず、respondWith も呼ばないので、
// API、SSE、Access のリダイレクトはすべて今までどおりネットワークに行く。オフラインには対応しない
export const SW_JS = `// ${PRODUCT_NAME} の Service Worker。ホーム画面に追加するためだけのもので、何もキャッシュしない
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));
self.addEventListener("fetch", () => {});
`;
