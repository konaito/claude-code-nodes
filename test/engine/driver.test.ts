import { test, expect } from "bun:test";
import { CapabilityError } from "../../src/engine/driver";

test("CapabilityError names the missing capability", () => {
  const e = new CapabilityError("interrupt");
  expect(e.capability).toBe("interrupt");
  expect(e.message).toContain("interrupt");
});
