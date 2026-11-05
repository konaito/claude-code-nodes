import { test, expect } from "bun:test";
import { parseArgs } from "../../src/cli/args";

test("parseArgs separates words and flags", () => {
  expect(parseArgs(["ls", "--peer", "vm", "--mine", "--wait=5", "-"])).toEqual({ words: ["ls", "-"], flags: { peer: "vm", mine: true, wait: "5" } });
  expect(parseArgs(["send", "vm/abc", "hello world", "--as", "lead"])).toEqual({ words: ["send", "vm/abc", "hello world"], flags: { as: "lead" } });
  expect(parseArgs(["new", "/tmp", "x", "--mode"])).toEqual({ words: ["new", "/tmp", "x"], flags: { mode: true } });
});
