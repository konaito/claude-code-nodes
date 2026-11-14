// 1枚の画面を配る。中身は index.html（ビルド無し）。状態はブラウザの localStorage だけで、画面専用の API は無い
import { join } from "node:path";
import { CLI_NAME, LEGACY_STORAGE_PREFIX, PRODUCT_NAME, PWA_MANIFEST_PATH, PWA_PATH, STORAGE_PREFIX, SW_PATH } from "../names";

// index.html の %%PRODUCT_NAME%%、%%CLI_NAME%%、%%STORAGE_PREFIX%%、%%LEGACY_STORAGE_PREFIX%%、%%PWA_PATH%%、%%PWA_MANIFEST_PATH%%、%%SW_PATH%% を names.ts の値に置き換える
export const pageHtml = async (): Promise<string> =>
  (await Bun.file(join(import.meta.dir, "index.html")).text())
    .replaceAll("%%PRODUCT_NAME%%", PRODUCT_NAME)
    .replaceAll("%%CLI_NAME%%", CLI_NAME)
    .replaceAll("%%PWA_MANIFEST_PATH%%", PWA_MANIFEST_PATH)
    .replaceAll("%%PWA_PATH%%", PWA_PATH)
    .replaceAll("%%SW_PATH%%", SW_PATH)
    .replaceAll("%%STORAGE_PREFIX%%", JSON.stringify(STORAGE_PREFIX).slice(1, -1))
    .replaceAll("%%LEGACY_STORAGE_PREFIX%%", JSON.stringify(LEGACY_STORAGE_PREFIX).slice(1, -1));
