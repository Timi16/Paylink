// Money is never a float: decimal strings at the edges, bigint stroops inside.
export const STROOPS_PER_UNIT = 10_000_000n;
export const AMOUNT_DECIMALS = 7;
/** Largest amount Stellar (int64) and Postgres BIGINT can hold. */
export const MAX_STROOPS = 9_223_372_036_854_775_807n;
export const AMOUNT_REGEX = /^\d{1,12}(\.\d{1,7})?$/;

/** Parses "50", "50.5", "0.0000001" into stroops. Returns null for anything else. */
export function parseAmount(input: string): bigint | null {
  if (typeof input !== "string" || !AMOUNT_REGEX.test(input)) return null;
  const [whole = "0", frac = ""] = input.split(".");
  const stroops = BigInt(whole) * STROOPS_PER_UNIT + BigInt(frac.padEnd(AMOUNT_DECIMALS, "0"));
  return stroops > MAX_STROOPS ? null : stroops;
}

/** Formats stroops as a 7-decimal string, e.g. 500000000n -> "50.0000000". */
export function formatStroops(stroops: bigint): string {
  const negative = stroops < 0n;
  const abs = negative ? -stroops : stroops;
  const whole = abs / STROOPS_PER_UNIT;
  const frac = (abs % STROOPS_PER_UNIT).toString().padStart(AMOUNT_DECIMALS, "0");
  return `${negative ? "-" : ""}${whole.toString()}.${frac}`;
}
