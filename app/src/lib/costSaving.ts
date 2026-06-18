// Cost-saving scoring (plan 006 §4.5, Phase E).
//
// The on-chain program stores only blake3 hashes of price snapshots — it cannot
// tell whether the buyer beat the "best-value snapshot" they were benchmarked
// against. That comparison runs here, off the cleartext per-unit prices held in
// `pendingSnapshots`, and (if the buyer won) an Owner/Parent fires the EXISTING
// `award_reward` instruction for `REWARD_COST_SAVING`. No Rust change is needed
// (Q3: the buyer cannot self-trigger this; an approver must be in the loop —
// acceptable for MVP, documented as a follow-up).
//
// Pure: no React, no Solana, no IO. The UI (CostSavingRewardForm) reads the
// snapshot from `pendingSnapshots`, hands it to `computeCostSaving`, and acts on
// the result. Keeping the math here makes it unit-testable and lets the UI stay
// a thin wiring layer.

import type { PendingSnapshot } from "./pendingSnapshots";

/** The result of comparing a request's benchmark against its actual cost. */
export type CostSaving = {
  /** The request this saving belongs to (echoed for the caller's convenience). */
  requestId: bigint;
  /**
   * `benchmarkPerUnitLamports - actualPerUnitLamports`.
   *
   * Positive ⇒ the buyer paid LESS per unit than the snapshot benchmark (they
   * beat it) ⇒ a cost-saving reward is due. Zero or negative ⇒ no saving.
   */
  savingPerUnitLamports: bigint;
  /** `savingPerUnitLamports > 0`. Convenience for the UI's gating. */
  isSaving: boolean;
  /** The benchmark per-unit price (the "best-value snapshot" picked at create). */
  benchmarkPerUnitLamports: bigint;
  /** The actual per-unit price the buyer paid at restock. */
  actualPerUnitLamports: bigint;
};

/**
 * Compare a request's benchmark against its actual, off the cleartext
 * per-unit prices stored client-side.
 *
 * Returns `null` when either side is missing — e.g. the snapshot or actual was
 * typed freehand (not via Compare prices), this is a different browser/device
 * than the one that recorded it, or the page was reloaded (the in-memory store
 * doesn't survive reload). In all those cases there's nothing to score; the UI
 * should surface a graceful "no comparison data" hint rather than a zero saving.
 *
 * Never throws — `bigint` subtraction is total for the (always-positive) inputs
 * `compareOffers` produces.
 */
export function computeCostSaving(snapshot: PendingSnapshot): CostSaving | null {
  if (!snapshot.benchmark || !snapshot.actual) return null;
  const benchmarkPerUnitLamports = snapshot.benchmark.perUnitLamports;
  const actualPerUnitLamports = snapshot.actual.perUnitLamports;
  const savingPerUnitLamports =
    benchmarkPerUnitLamports - actualPerUnitLamports;
  return {
    requestId: snapshot.requestId,
    savingPerUnitLamports,
    isSaving: savingPerUnitLamports > 0n,
    benchmarkPerUnitLamports,
    actualPerUnitLamports,
  };
}

/**
 * Build the deterministic reason text whose blake3 digest is passed to
 * `award_reward` as `reason_hash`.
 *
 * Format: `cost-saving:request:<requestId>:<savingPerUnitLamports>`. Tied to
 * the specific request (a saving belongs to a purchase, not just a product) and
 * to the exact saving magnitude, so the on-chain hash is reproducible from the
 * client record and auditable against it. The cleartext never goes on-chain —
 * only `toHash32(reasonText)` does.
 */
export function costSavingReasonText(
  requestId: bigint,
  savingPerUnitLamports: bigint,
): string {
  return `cost-saving:request:${requestId}:${savingPerUnitLamports}`;
}
