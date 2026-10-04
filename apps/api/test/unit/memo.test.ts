import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { generateMemo, normalizeMemo } from "../../src/lib/memo";

describe("memo", () => {
  it("generates PL + 8 Crockford characters", () => {
    for (let i = 0; i < 200; i++) expect(generateMemo()).toMatch(/^PL[0-9A-HJKMNP-TV-Z]{8}$/);
  });

  it("P4: normalises lowercase, O for 0, I/L for 1, spaces and dashes", () => {
    expect(normalizeMemo("PL7K2M9QXA")).toBe("PL7K2M9QXA");
    expect(normalizeMemo("pl7k2m9qxa")).toBe("PL7K2M9QXA");
    expect(normalizeMemo("  PL-7K2M 9QXA ")).toBe("PL7K2M9QXA");
    expect(normalizeMemo("PLO0OOOOOO")).toBe("PL00000000");
    expect(normalizeMemo("PLIL1il1AB")).toBe("PL111111AB");
    expect(normalizeMemo("pl 0o-1i-lL-ZZ")).toBe("PL001111ZZ");
  });

  it("rejects anything that is not a PayLink memo", () => {
    for (const bad of ["", "PL", "PL7K2M9QX", "PL7K2M9QXAB", "XX7K2M9QXA", "PL7K2M9QXU", "hello", "PL7K2M9QX!", "1234567890"]) {
      expect(normalizeMemo(bad), bad).toBeNull();
    }
  });

  it("P4: every generated memo survives being retyped in any case with separators", () => {
    fc.assert(
      fc.property(fc.constant(null).map(generateMemo), fc.boolean(), (memo, lower) => {
        const typed = `${memo.slice(0, 2)}-${memo.slice(2, 6)} ${memo.slice(6)}`;
        expect(normalizeMemo(lower ? typed.toLowerCase() : typed)).toBe(memo);
      }),
    );
  });
});
