// Price-per-unit comparison engine for the Stocksie best-value feature.
//
// Pure: no React, no Solana, no IO. The single export `compareOffers()` takes
// two or more store offers for the same household essential and ranks them by
// price-per-unit (lamports per gram/ml), so the UI can surface "which pack is
// actually cheaper" — README Feature #3, wired off-chain.
//
// Why off-chain (plan 006 §3, docs/PRIVACY.md): the on-chain program stores
// only a `blake3` hash of any price text (tamper-evidence), not the cleartext.
// The chain cannot compare prices it cannot read, so the ranking runs here in
// JavaScript against the cleartext the client already holds at entry time.
//
// No float is used in the ranking — only `bigint` cross-products — so two
// offers that differ by a sub-lamport never tie incorrectly. Float appears
// solely in the display-only `savingsPctVsBest`.

/** A purchasable offer for one essential, held in client state / the shelf. */
export type Offer = {
  /** Shelf product FK (or synthetic id); UI round-trip only. */
  productId: string;
  /** Human label, e.g. "2-pack, 500ml". Display only. */
  label: string;
  /** Total price of this offer, in lamports. Must be > 0. */
  priceLamports: bigint;
  /** Number of units in the pack (1, 2, 6, ...). Must be > 0. */
  packUnits: number;
  /** Weight/volume of ONE unit, in grams (ml treated as grams). Must be > 0. */
  unitGrams: number;
};

/** An offer enriched with its per-unit ranking. */
export type RankedOffer = Offer & {
  /** Lamports per gram, bigint-floored. Exact ordering basis. */
  perUnitLamports: bigint;
  /** Same value as a `number`, for display only. */
  perUnitLamportsRounded: number;
  /** 1 = cheapest per unit. Ties broken by lower absolute price, then input order. */
  rank: number;
  /** 0 for the best; > 0 for the rest. Display only (float). */
  savingsPctVsBest: number;
  /** Convenience: `rank === 1`. */
  isBest: boolean;
};

export type BestValueErrorCode =
  | "empty"
  | "non_positive_price"
  | "non_positive_pack_units"
  | "non_positive_unit_grams"
  | "non_finite_unit_grams";

/** Typed error so callers can distinguish bad input from unexpected failures. */
export class BestValueError extends Error {
  readonly code: BestValueErrorCode;

  constructor(code: BestValueErrorCode, message: string) {
    super(message);
    this.name = "BestValueError";
    this.code = code;
  }
}

/**
 * Rank offers by price-per-unit (lamports per gram), cheapest first.
 *
 * - Empty input → `BestValueError("empty")`.
 * - Any `priceLamports <= 0`, `packUnits <= 0`, or `unitGrams <= 0` → typed
 *   error (these make per-unit math meaningless or divide-by-zero).
 * - A single offer is valid: it returns ranked #1 with 0 savings.
 * - Fractional `unitGrams` (e.g. 12.5) are supported via milligram scaling.
 * - Ties on per-unit are broken by lower absolute `priceLamports`, then by
 *   stable input order (`Array#sort` is stable on Node 12+).
 */
export function compareOffers(offers: Offer[]): RankedOffer[] {
  if (offers.length === 0) {
    throw new BestValueError(
      "empty",
      "compareOffers requires at least one offer.",
    );
  }

  // Validate + derive a per-unit value. `perUnitLamports` is lamports-per-gram,
  // computed as price * 1000 / totalMg so it stays in exact `bigint`.
  const rows = offers.map((offer) => {
    validate(offer);
    const totalMg = totalMilligrams(offer);
    const perUnitLamports = (offer.priceLamports * 1000n) / BigInt(totalMg);
    return {
      offer,
      totalMg,
      perUnitLamports,
      perUnitLamportsRounded: Number(perUnitLamports),
    };
  });

  // Exact ranking via cross-products: a/b < c/d  ⟺  a*d < c*b  (all positive).
  // This avoids any float in the ordering. Ties fall through to absolute price,
  // then stable input order.
  rows.sort((a, b) => {
    const left = a.offer.priceLamports * BigInt(b.totalMg);
    const right = b.offer.priceLamports * BigInt(a.totalMg);
    if (left !== right) return left < right ? -1 : 1;
    if (a.offer.priceLamports !== b.offer.priceLamports) {
      return a.offer.priceLamports < b.offer.priceLamports ? -1 : 1;
    }
    return 0;
  });

  const best = rows[0];

  return rows.map((row, i) => {
    const savingsPctVsBest =
      i === 0
        ? 0
        : // Display-only percentage in float; consistent with the exact ranking
          // because it renders the same per-unit ratio.
          (perUnitFloat(row.offer) / perUnitFloat(best.offer) - 1) * 100;
    return {
      ...row.offer,
      perUnitLamports: row.perUnitLamports,
      perUnitLamportsRounded: row.perUnitLamportsRounded,
      rank: i + 1,
      savingsPctVsBest,
      isBest: i === 0,
    };
  });
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

function validate(offer: Offer): void {
  if (offer.priceLamports <= 0n) {
    throw new BestValueError(
      "non_positive_price",
      `Offer "${offer.label}" has non-positive price (${offer.priceLamports} lamports).`,
    );
  }
  if (offer.packUnits <= 0) {
    throw new BestValueError(
      "non_positive_pack_units",
      `Offer "${offer.label}" has non-positive packUnits (${offer.packUnits}).`,
    );
  }
  if (!Number.isFinite(offer.unitGrams)) {
    throw new BestValueError(
      "non_finite_unit_grams",
      `Offer "${offer.label}" has non-finite unitGrams (${offer.unitGrams}).`,
    );
  }
  if (offer.unitGrams <= 0) {
    throw new BestValueError(
      "non_positive_unit_grams",
      `Offer "${offer.label}" has non-positive unitGrams (${offer.unitGrams}).`,
    );
  }
}

/**
 * Total weight in integer milligrams (`unitGrams * 1000 * packUnits`).
 * `Math.round` absorbs float noise (e.g. 12.5 * 1000 → 12500.000…1).
 */
function totalMilligrams(offer: Offer): number {
  return Math.round(offer.unitGrams * 1000) * offer.packUnits;
}

/** Float lamports-per-gram, display only. `priceLamports` fits a safe integer. */
function perUnitFloat(offer: Offer): number {
  return Number(offer.priceLamports) / (totalMilligrams(offer) / 1000);
}
