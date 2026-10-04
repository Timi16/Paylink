import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { formatStroops, MAX_STROOPS, parseAmount } from "../../src/lib/amount";

describe("amount", () => {
  it("parses decimal strings to stroops", () => {
    expect(parseAmount("50")).toBe(500_000_000n);
    expect(parseAmount("50.5")).toBe(505_000_000n);
    expect(parseAmount("0.0000001")).toBe(1n);
    expect(parseAmount("0")).toBe(0n);
    expect(parseAmount("922337203685.4775807")).toBe(MAX_STROOPS);
  });

  it("M8: rejects negative, >7 decimals, too large and malformed amounts", () => {
    for (const bad of ["-1", "1.00000001", "922337203685.4775808", "999999999999.9999999", "1e3", "1,5", " 1", "1.", ".5", "", "abc", "0x10", "1234567890123"]) {
      expect(parseAmount(bad), bad).toBeNull();
    }
  });

  it("formats with exactly 7 decimals", () => {
    expect(formatStroops(500_000_000n)).toBe("50.0000000");
    expect(formatStroops(1n)).toBe("0.0000001");
    expect(formatStroops(0n)).toBe("0.0000000");
    expect(formatStroops(MAX_STROOPS)).toBe("922337203685.4775807");
  });

  it("P18: one stroop is never rounded away (round-trips exactly)", () => {
    fc.assert(
      fc.property(fc.bigInt({ min: 0n, max: MAX_STROOPS }), (stroops) => {
        expect(parseAmount(formatStroops(stroops))).toBe(stroops);
      }),
    );
    expect(parseAmount("50.0000001")).toBe(500_000_001n);
    expect(parseAmount("49.9999999")).toBe(499_999_999n);
  });

  it("agrees with integer arithmetic for any valid decimal string", () => {
    fc.assert(
      fc.property(fc.bigInt({ min: 0n, max: 99_999_999_999n }), fc.integer({ min: 0, max: 9_999_999 }), (whole, frac) => {
        const text = `${whole}.${frac.toString().padStart(7, "0")}`;
        expect(parseAmount(text)).toBe(whole * 10_000_000n + BigInt(frac));
      }),
    );
  });
});
