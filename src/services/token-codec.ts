import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import type { WithingsTokenSet } from "../types.js";

const FORMAT = "withings-token-v1";
const AAD = Buffer.from(FORMAT);

export function tokenKey(value?: string): Buffer | undefined {
  if (value === undefined) return undefined;
  if (!/^[A-Za-z0-9_-]{43}$/.test(value) || Buffer.from(value, "base64url").length !== 32) {
    throw new Error("WITHINGS_TOKEN_ENCRYPTION_KEY must be 32 bytes encoded as unpadded base64url.");
  }
  return Buffer.from(value, "base64url");
}

export function encodeTokens(tokens: WithingsTokenSet, key?: Buffer): string {
  const plain = JSON.stringify(tokens);
  if (!key) return plain;
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  cipher.setAAD(AAD);
  const ciphertext = Buffer.concat([cipher.update(plain, "utf8"), cipher.final(), cipher.getAuthTag()]);
  return JSON.stringify({ format: FORMAT, nonce: nonce.toString("base64url"), ciphertext: ciphertext.toString("base64url") });
}

export function decodeTokens(text: string, key?: Buffer): WithingsTokenSet {
  try {
    const envelope = JSON.parse(text);
    if (!key) {
      if (envelope?.format === FORMAT) throw new Error();
      return envelope as WithingsTokenSet;
    }
    if (!envelope || Object.keys(envelope).sort().join(",") !== "ciphertext,format,nonce" || envelope.format !== FORMAT ||
        typeof envelope.nonce !== "string" || !/^[A-Za-z0-9_-]{16}$/.test(envelope.nonce) ||
        typeof envelope.ciphertext !== "string" || !/^[A-Za-z0-9_-]{22,}$/.test(envelope.ciphertext)) throw new Error();
    const nonce = Buffer.from(envelope.nonce, "base64url");
    const data = Buffer.from(envelope.ciphertext, "base64url");
    const decipher = createDecipheriv("aes-256-gcm", key, nonce);
    decipher.setAAD(AAD);
    decipher.setAuthTag(data.subarray(-16));
    return JSON.parse(Buffer.concat([decipher.update(data.subarray(0, -16)), decipher.final()]).toString("utf8")) as WithingsTokenSet;
  } catch {
    throw new Error("Cannot read Withings token store: check encryption configuration and saved credentials.");
  }
}
