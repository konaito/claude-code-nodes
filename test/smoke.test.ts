import { test, expect } from "bun:test";
test("sdk is pinned to the cli version", async () => {
  const pkg = await Bun.file("node_modules/@anthropic-ai/claude-agent-sdk/package.json").json();
  expect(pkg.version).toBe("0.3.318");
});
