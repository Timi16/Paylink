import { randomInt } from "node:crypto";

const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"; // Crockford, no I L O U
const MEMO_REGEX = /^PL[0-9A-HJKMNP-TV-Z]{8}$/;

/** "PL" + 8 Crockford base32 characters from a CSPRNG (40 bits). */
export function generateMemo(): string {
  let out = "PL";
  for (let i = 0; i < 8; i++) out += ALPHABET[randomInt(ALPHABET.length)];
  return out;
}

const MAX_MEMO_ID = 1n << 40n;

/**
 * Every memo is also a number: its 8 Crockford characters are 40 bits. That number is the
 * request's second reference, for payers who cannot attach a text memo: it works as a
 * MEMO_ID, and as the id of a muxed (M…) destination, which is the only reference a
 * Soroban / contract-wallet transfer can carry.
 */
export function memoToId(memo: string): bigint {
  let id = 0n;
  for (const ch of memo.slice(2)) id = (id << 5n) | BigInt(ALPHABET.indexOf(ch));
  return id;
}

/** Inverse of memoToId. Returns null for anything that is not a 40-bit decimal number. */
export function idToMemo(raw: string): string | null {
  if (!/^\d{1,13}$/.test(raw)) return null;
  let id = BigInt(raw);
  if (id >= MAX_MEMO_ID) return null;
  let body = "";
  for (let i = 0; i < 8; i++) {
    body = ALPHABET[Number.parseInt((id & 31n).toString(), 10)] + body;
    id >>= 5n;
  }
  return `PL${body}`;
}

/**
 * Forgiving of hand-typed memos: trims, uppercases, strips spaces and dashes, and maps the
 * Crockford look-alikes O -> 0 and I/L -> 1. The "PL" prefix is literal, so its L is kept.
 * Returns null unless the result is a well-formed PayLink memo.
 */
export function normalizeMemo(raw: string): string | null {
  const cleaned = raw.trim().toUpperCase().replace(/[\s-]/g, "");
  if (!cleaned.startsWith("PL")) return null;
  const body = cleaned.slice(2).replace(/O/g, "0").replace(/[IL]/g, "1");
  const memo = `PL${body}`;
  return MEMO_REGEX.test(memo) ? memo : null;
}
