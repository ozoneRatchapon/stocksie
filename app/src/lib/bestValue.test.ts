import { describe, expect, it } from "vitest";
import { BestValueError, compareOffers, type Offer } from "./bestValue";

/** Build an offer with sensible defaults; pass the fields under test. */
function offer(
  over: Partial<Offer> & {
    priceLamports: bigint;
    packUnits: number;
    unitGrams: number;
  },
): Offer {
  return { productId: "p", label: "offer", ...over };
}

describe("compareOffers — ranking", () => {
  it("ranks by price-per-unit, cheapest first", () => {
    // A: 1000 lamports / 100g = 10 lamports/g
    // B: 1500 lamports / 100g = 15 lamports/g  -> more expensive per gram
    const ranked = compareOffers([
      offer({ productId: "B", priceLamports: 1500n, packUnits: 1, unitGrams: 100 }),
      offer({ productId: "A", priceLamports: 1000n, packUnits: 1, unitGrams: 100 }),
    ]);
    expect(ranked.map((r) => r.productId)).toEqual(["A", "B"]);
    expect(ranked[0].isBest).toBe(true);
    expect(ranked[1].rank).toBe(2);
  });

  it("prefers the bigger pack when its per-unit is cheaper", () => {
    // small: 1L (1000g) at 3000 -> 3 lamports/g
    // big:   2L (2000g) at 5000 -> 2.5 lamports/g  -> cheaper per gram
    const ranked = compareOffers([
      offer({ productId: "small", priceLamports: 3000n, packUnits: 1, unitGrams: 1000 }),
      offer({ productId: "big", priceLamports: 5000n, packUnits: 1, unitGrams: 2000 }),
    ]);
    expect(ranked[0].productId).toBe("big");
    expect(ranked[0].savingsPctVsBest).toBe(0);
    expect(ranked[1].savingsPctVsBest).toBeGreaterThan(0);
  });

  it("multiplies unit weight by pack size (a 6-pack is 6× the grams)", () => {
    // 6-pack of 100g = 600g total, at 6000 -> 10 lamports/g
    const ranked = compareOffers([
      offer({ priceLamports: 6000n, packUnits: 6, unitGrams: 100 }),
    ]);
    expect(ranked[0].perUnitLamports).toBe(10n);
  });

  it("breaks per-unit ties by lower absolute price", () => {
    // both 10 lamports/g (1000/100 == 2000/200), but A is cheaper overall
    const ranked = compareOffers([
      offer({ productId: "B", priceLamports: 2000n, packUnits: 1, unitGrams: 200 }),
      offer({ productId: "A", priceLamports: 1000n, packUnits: 1, unitGrams: 100 }),
    ]);
    expect(ranked[0].productId).toBe("A");
  });

  it("handles fractional unitGrams via milligram scaling", () => {
    // 12.5g unit, 12500 lamports -> 12500*1000/12500 = 1000 lamports/g
    const ranked = compareOffers([
      offer({ priceLamports: 12500n, packUnits: 1, unitGrams: 12.5 }),
    ]);
    expect(ranked[0].perUnitLamports).toBe(1000n);
  });

  it("returns a single offer ranked #1 with zero savings", () => {
    const ranked = compareOffers([
      offer({ priceLamports: 500n, packUnits: 1, unitGrams: 50 }),
    ]);
    expect(ranked).toHaveLength(1);
    expect(ranked[0].rank).toBe(1);
    expect(ranked[0].isBest).toBe(true);
    expect(ranked[0].savingsPctVsBest).toBe(0);
  });
});

describe("compareOffers — validation", () => {
  it("throws BestValueError(empty) on empty input", () => {
    expect(() => compareOffers([])).toThrow(BestValueError);
    expect(() => compareOffers([])).toThrow(/at least one offer/);
  });

  it("throws on non-positive price", () => {
    expect(() =>
      compareOffers([offer({ priceLamports: 0n, packUnits: 1, unitGrams: 100 })]),
    ).toThrow(BestValueError);
  });

  it("throws on non-positive packUnits", () => {
    expect(() =>
      compareOffers([offer({ priceLamports: 100n, packUnits: 0, unitGrams: 100 })]),
    ).toThrow(BestValueError);
  });

  it("throws on non-positive unitGrams", () => {
    expect(() =>
      compareOffers([offer({ priceLamports: 100n, packUnits: 1, unitGrams: 0 })]),
    ).toThrow(BestValueError);
  });
});
