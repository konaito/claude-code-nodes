import { test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import * as N from "../src/names";
import { pageHtml } from "../src/web/page";
import { installerScript } from "../src/join/installer";

const root = join(import.meta.dir, "..");

test("package.json name matches names.ts", () => {
  expect((JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { name: string }).name).toBe(N.PACKAGE_NAME);
});

test("the page gets the product name and the localStorage prefix from names.ts", async () => {
  const html = await pageHtml();
  expect(html).not.toContain("%%");
  expect(html).toContain(`<title>${N.PRODUCT_NAME}</title>`);
  expect(html).toContain(`const K = "${N.STORAGE_PREFIX}";`);
  expect(html).not.toMatch(/store\.(get|set)\("cc\./);
});

test("the installer uses the bundle path, the app home and the entry script from names.ts", () => {
  const s = installerScript({ entry: "https://x.example", cliName: N.CLI_NAME });
  expect(s).toContain(`TARBALL="https://x.example${N.BUNDLE_PATH}"`);
  expect(s).toContain(`APP="${N.appHomeOf("$HOME")}/app"`);
  expect(s).toContain(`bun run ${N.ENTRY_SCRIPT.join("/")} install`);
});

test("bin/ccn and the smoke scripts use the same names (they cannot import names.ts)", () => {
  expect(readFileSync(join(root, "bin", N.CLI_NAME), "utf8")).toContain(N.ENTRY_SCRIPT.join("/"));
  const remote = readFileSync(join(root, "scripts", "smoke-remote.sh"), "utf8");
  expect(remote).toContain(`${N.CONFIG_ENV}:-`);
  expect(remote).toContain(N.configDirOf("$HOME") + "/" + N.CONFIG_FILE);
  expect(remote).toContain(`${N.HEADER_FROM}:`);
});
