import { describe, expect, it, beforeEach } from "vitest";
import {
  __clearAllForTests,
  clearSnapshot,
  getSnapshot,
  setActual,
  setBenchmark,
  type SnapshotSide,
} from "./pendingSnapshots";

/** Build a snapshot side with sensible defaults; pass the fields under test. */
function side(over: Partial<SnapshotSide> & { perUnitLamports: bigint }): SnapshotSide {
  return {
    priceLamports: 1000n,
    label: "offer",
    packUnits: 1,
    unitGrams: 100,
    ...over,
  };
}

describe("pendingSnapshots", () => {
  beforeEach(() => {
    __clearAllForTests();
  });

  it("stores a benchmark keyed by request id", () => {
    setBenchmark(1n, side({ perUnitLamports: 10n, label: "benchmark A" }));
    const record = getSnapshot(1n);
    expect(record).toBeDefined();
    expect(record?.benchmark?.label).toBe("benchmark A");
    expect(record?.actual).toBeUndefined();
  });

  it("stores an actual for the same request without clobbering the benchmark", () => {
    setBenchmark(2n, side({ perUnitLamports: 15n, label: "bench" }));
    setActual(2n, side({ perUnitLamports: 12n, label: "actual" }));
    const record = getSnapshot(2n);
    expect(record?.benchmark?.label).toBe("bench");
    expect(record?.actual?.label).toBe("actual");
    // The same record is mutated in place — updatedAt moves forward.
    expect(record?.updatedAt).toBeGreaterThan(0);
  });

  it("returns undefined for an unknown request id", () => {
    expect(getSnapshot(999n)).toBeUndefined();
  });

  it("overwrites a benchmark on re-set", () => {
    setBenchmark(3n, side({ perUnitLamports: 20n, label: "first" }));
    setBenchmark(3n, side({ perUnitLamports: 18n, label: "second" }));
    expect(getSnapshot(3n)?.benchmark?.label).toBe("second");
    expect(getSnapshot(3n)?.benchmark?.perUnitLamports).toBe(18n);
  });

  it("clears a record by request id", () => {
    setBenchmark(4n, side({ perUnitLamports: 5n }));
    expect(getSnapshot(4n)).toBeDefined();
    clearSnapshot(4n);
    expect(getSnapshot(4n)).toBeUndefined();
  });

  it("distinguishes records by request id (no cross-talk)", () => {
    setBenchmark(10n, side({ perUnitLamports: 100n, label: "ten" }));
    setBenchmark(20n, side({ perUnitLamports: 200n, label: "twenty" }));
    expect(getSnapshot(10n)?.benchmark?.label).toBe("ten");
    expect(getSnapshot(20n)?.benchmark?.label).toBe("twenty");
  });
});
