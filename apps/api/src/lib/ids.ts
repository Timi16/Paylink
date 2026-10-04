import { createHash, createHmac, randomBytes, randomInt } from "node:crypto";
import { env } from "../config/env";

const BASE62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

export function randomBase62(length: number): string {
  let out = "";
  for (let i = 0; i < length; i++) out += BASE62[randomInt(BASE62.length)];
  return out;
}

/** 12 random base62 chars (~71 bits): the unguessable id in /pay/{publicId}. */
export function generatePublicId(): string {
  return randomBase62(12);
}

export const API_KEY_PREFIX = "pl_test_";

/** pl_test_ + 43 base62 chars (~256 bits). Only the SHA-256 is stored. */
export function generateApiKey(): { key: string; prefix: string; keyHash: string } {
  const key = API_KEY_PREFIX + randomBase62(43);
  return { key, prefix: key.slice(0, API_KEY_PREFIX.length + 4), keyHash: hashApiKey(key) };
}

export function hashApiKey(key: string): string {
  return createHash("sha256").update(key).digest("hex");
}

/** 32 random bytes, base64url. Goes in the cookie; never stored. */
export function generateSessionToken(): string {
  return randomBytes(32).toString("base64url");
}

/** Session row id: SHA-256 of the token, keyed with SESSION_SECRET so a DB leak alone is useless. */
export function hashSessionToken(token: string): string {
  return createHmac("sha256", Buffer.from(env.SESSION_SECRET, "hex")).update(token).digest("hex");
}

export function randomNonce(): string {
  return randomBytes(16).toString("hex");
}

export function sha256Hex(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}
