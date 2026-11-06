import { test, expect } from "bun:test";
import { buildDeps } from "../src/main";
import { AccessIdentity } from "../src/identity/access";
import { HeaderIdentity } from "../src/identity/identity";
import { CloudflareRegistry } from "../src/registry/cloudflare";
import { StaticRegistry } from "../src/registry/registry";

// 組み立て。Access の設定があるノードは JWT を検証し、無いノードはヘッダだけを見る
test("buildDeps uses AccessIdentity and CloudflareRegistry when the config has them", () => {
  const d = buildDeps({ name: "vm", port: 4322, roots: ["/"], domain: "cc.fybe.jp", teamDomain: "t.cloudflareaccess.com", aud: "a", accountId: "acc", cfApiToken: "tok", serviceToken: { clientId: "c", clientSecret: "s" } });
  expect(d.identity).toBeInstanceOf(AccessIdentity);
  expect(d.registry).toBeInstanceOf(CloudflareRegistry);
});

test("buildDeps falls back to HeaderIdentity and StaticRegistry without them", () => {
  const d = buildDeps({ name: "dev", port: 4399, roots: ["/"] });
  expect(d.identity).toBeInstanceOf(HeaderIdentity);
  expect(d.registry).toBeInstanceOf(StaticRegistry);
});
