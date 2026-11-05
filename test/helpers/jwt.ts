// 試験用の JWT。本物の RSA 鍵で署名し、JWKS の形で公開鍵を渡す。Access の JWKS と同じ形
import type { Jwks } from "../../src/identity/access";

const b64url = (b: ArrayBuffer | Uint8Array | string) => {
  const bytes = typeof b === "string" ? new TextEncoder().encode(b) : b instanceof Uint8Array ? b : new Uint8Array(b);
  return Buffer.from(bytes).toString("base64url");
};

export async function makeKeys(kid = "k1"): Promise<{ jwks: Jwks; sign: (payload: Record<string, unknown>, opts?: { kid?: string; alg?: string }) => Promise<string> }> {
  const pair = await crypto.subtle.generateKey({ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign", "verify"]);
  const pub = (await crypto.subtle.exportKey("jwk", pair.publicKey)) as JsonWebKey & { kid: string };
  pub.kid = kid;
  pub.alg = "RS256";
  pub.use = "sig";
  return {
    jwks: { keys: [pub] },
    sign: async (payload, opts = {}) => {
      const h = b64url(JSON.stringify({ alg: opts.alg ?? "RS256", kid: opts.kid ?? kid, typ: "JWT" }));
      const p = b64url(JSON.stringify(payload));
      const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", pair.privateKey, new TextEncoder().encode(`${h}.${p}`));
      return `${h}.${p}.${b64url(sig)}`;
    },
  };
}
