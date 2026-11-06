// 1枚の画面を配る。中身は index.html（ビルド無し）。状態はブラウザの localStorage だけで、画面専用の API は無い
import { join } from "node:path";

export const pageHtml = (): Promise<string> => Bun.file(join(import.meta.dir, "index.html")).text();
