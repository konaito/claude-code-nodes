import { test, expect } from "bun:test";
import { encodeJoinToken, decodeJoinToken, JoinTokenError, configFromToken, type JoinToken } from "../../src/join/token";
import { homedir } from "node:os";

const tok: JoinToken = {
  v: 1, name: "vm", port: 4322, domain: "cc.fybe.jp", zone: "fybe.jp", teamDomain: "fybejp.cloudflareaccess.com", aud: "aud1", accountId: "acc",
  entry: "https://vm.cc.fybe.jp", tunnelToken: "eyJ-tunnel", serviceToken: { clientId: "cid", clientSecret: "csec" }, cfApiToken: "cf-tok",
};

test("join token round-trips", () => {
  const s = encodeJoinToken(tok);
  expect(s).toMatch(/^[A-Za-z0-9_-]+$/);
  expect(decodeJoinToken(s)).toEqual(tok);
});

test("decode strips whitespace and rejects missing fields by name", () => {
  expect(decodeJoinToken(`  ${encodeJoinToken(tok)}\n`)).toEqual(tok);
  const { serviceToken: _s, ...noService } = tok;
  const err = (() => { try { decodeJoinToken(encodeJoinToken(noService as JoinToken)); } catch (e) { return e; } })();
  expect(err).toBeInstanceOf(JoinTokenError);
  expect((err as Error).message).toContain("serviceToken");
  expect(() => decodeJoinToken("not*base64")).toThrow(JoinTokenError);
  expect(() => decodeJoinToken("")).toThrow(JoinTokenError);
});

test("configFromToken builds the node config with $HOME as the root", () => {
  const c = configFromToken(tok);
  expect(c).toEqual({ name: "vm", port: 4322, roots: [homedir()], domain: "cc.fybe.jp", zone: "fybe.jp", teamDomain: "fybejp.cloudflareaccess.com", aud: "aud1", accountId: "acc", entry: "https://vm.cc.fybe.jp", serviceToken: { clientId: "cid", clientSecret: "csec" }, cfApiToken: "cf-tok" });
  expect("tunnelToken" in c).toBe(false);
});
