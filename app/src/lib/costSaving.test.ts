import { describe, expect, it } from "vitest";
import {
  computeCostSaving,
  costSavingReasonText,
} from "./costSaving";
import type { PendingSnapshot, SnapshotSide } from "./pendingSnapshots";

/** Build a PendingSnapshot with both sides overridable. */
function snapshot(
  over: Partial<Pick<PendingSnapshot, "benchmark" | "actual">> & {
    requestId?: bigint;
  },
): PendingSnapshot {
  return {
    requestId: over.requestId ?? 1n,
    benchmark: over.benchmark,
    actual: over.actual,
    updatedAt: 0,
  };
}

/** Build a snapshot side; only per-unit matters for scoring. */
function side(perUnitLamports: bigint): SnapshotSide {
  return {
    priceLamports: perUnitLamports,
    perUnitLamports,
    label: "offer",
    packUnits: 1,
    unitGrams: 100,
  };
}

describe("computeCostSaving", () => {
  it("returns null when the benchmark is missing", () => {
    expect(computeCostSaving(snapshot({ actual: side(10n) }))).toBeNull();
  });

  it("returns null when the actual is missing", () => {
    expect(computeCostSaving(snapshot({ benchmark: side(10n) }))).toBeNull();
  });

  it("returns null when both sides are missing", () => {
    expect(computeCostSaving(snapshot({}))).toBeNull();
  });

  it("flags a saving when the buyer beats the benchmark", () => {
    // benchmark 15 lamports/g, actual 10 lamports/g -> saving 5 lamports/g
    const result = computeCostSaving(
      snapshot({ benchmark: side(15n), actual: side(10n) }),
    );
    expect(result).not.toBeNull();
    expect(result?.savingPerUnitLamports).toBe(5n);
    expect(result?.isSaving).toBe(true);
  });

  it("is not a saving when the buyer matches the benchmark", () => {
    const result = computeCostSaving(
      snapshot({ benchmark: side(10n), actual: side(10n) }),
    );
    expect(result?.savingPerUnitLamports).toBe(0n);
    expect(result?.isSaving).toBe(false);
  });

  it("is not a saving when the buyer pays more than the benchmark", () => {
    // benchmark 10, actual 12 -> -2 (no reward)
    const result = computeCostSaving(
      snapshot({ benchmark: side(10n), actual: side(12n) }),
    );
    expect(result?.savingPerUnitLamports).toBe(-2n);
    expect(result?.isSaving).toBe(false);
  });

  it("echoes the per-unit prices and request id", () => {
    const result = computeCostSaving(
      snapshot({
        requestId: 42n,
        benchmark: side(20n),
        actual: side(8n),
      }),
    );
    expect(result?.requestId).toBe(42n);
    expect(result?.benchmarkPerUnitLamports).toBe(20n);
    expect(result?.actualPerUnitLamports).toBe(8n);
  });
});

describe("costSavingReasonText", () => {
  it("is deterministic for a given request + saving", () => {
    expect(costSavingReasonText(7n, 5n)).toBe("cost-saving:request:7:5");
  });

  it("distinguishes requests and saving magnitudes", () => {
    expect(costSavingReasonText(7n, 5n)).not.toBe(costSavingReasonText(8n, 5n));
    expect(costSavingReasonText(7n, 5n)).not.toBe(costSavingReasonText(7n, 6n));
  });

  it("encodes negative (no-saving) magnitudes too, for audit symmetry", () => {
    expect(costSavingReasonText(7n, -2n)).toBe("cost-saving:request:7:-2");
  });
});
