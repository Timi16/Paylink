import { randomInt } from "node:crypto";

const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"; // Crockford, no I L O U
const MEMO_REGEX = /^PL[0-9A-HJKMNP-TV-Z]{8}$/;

/** "PL" + 8 Crockford base32 characters from a CSPRNG (40 bits). */
export function generateMemo(): string {
  let out = "PL";
  for (let i = 0; i < 8; i++) out += ALPHABET[randomInt(ALPHABET.length)];
  return out;
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
