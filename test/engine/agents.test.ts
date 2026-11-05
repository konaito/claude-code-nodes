import { test, expect } from "bun:test";
import { listAgents, socketPathFor } from "../../src/engine/agents";

test("listAgents parses the real json shape", async () => {
  const run = async () => ({ stdout: await Bun.file("test/fixtures/agents.json").text(), code: 0 });
  const list = await listAgents(run);
  expect(list.length).toBe(3);
  expect(list[0].pid).toBe(14356);
  expect(list[0].kind).toBe("interactive");
  expect(list[0].sessionId).toBe("bfa86f8f-1741-459d-9473-052f8c0aa56f");
  expect(list[1].waitingFor).toBe("permission prompt");
});

test("listAgents returns [] when the command fails", async () => {
  const run = async () => ({ stdout: "", code: 1 });
  expect(await listAgents(run)).toEqual([]);
});

test("socketPathFor lists both candidate paths in order", () => {
  expect(socketPathFor(123, 501)).toEqual(["/tmp/cc-socks/123.sock", "/tmp/cc-socks-501/123.sock"]);
});
