// 1枚の画面を配る。中身は index.html（ビルド無し）。状態はブラウザの localStorage だけで、画面専用の API は無い
import { join } from "node:path";
import { LEGACY_STORAGE_PREFIX, PRODUCT_NAME, STORAGE_PREFIX } from "../names";

// index.html の %%PRODUCT_NAME%%、%%STORAGE_PREFIX%%、%%LEGACY_STORAGE_PREFIX%% を names.ts の値に置き換える
export const pageHtml = async (): Promise<string> =>
  (await Bun.file(join(import.meta.dir, "index.html")).text())
    .replaceAll("%%PRODUCT_NAME%%", PRODUCT_NAME)
    .replaceAll("%%STORAGE_PREFIX%%", JSON.stringify(STORAGE_PREFIX).slice(1, -1))
    .replaceAll("%%LEGACY_STORAGE_PREFIX%%", JSON.stringify(LEGACY_STORAGE_PREFIX).slice(1, -1));
