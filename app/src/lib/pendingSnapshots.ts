// In-memory store of best-value snapshots keyed by request id (plan 006 §4.5, D.3).
//
// ## What this holds, and why
//
// The cost-saving reward (REWARD_COST_SAVING) needs BOTH of these, for the same
// purchase request, to compute a saving:
//
//   1. The **benchmark** — the offer picked at `create_purchase_request` as the
//      "best-value snapshot". Its per-unit price is the bar the buyer is trying
//      to beat.
//   2. The **actual** — the offer the buyer actually picked up at `confirm_restock`.
//
// Neither per-unit price can come from the chain: the on-chain program stores
// only a blake3 hash of the snapshot text (tamper-evidence), never the
// cleartext. So the structured per-unit data lives here, in client memory,
// keyed by the request id the snapshots belong to.
//
// ## Scope / limitations (deliberate, see plan 006 Q4)
//
// This is **in-memory only** — a module-level `Map`. It does NOT survive a page
// reload, and it is NOT shared across devices. That is the simplest viable
// persistence (plan D.3: "pick the simpler one"). Consequences:
//
//   - If the user creates a request, reloads, then marks it bought, the
//     benchmark is gone → the post-restock scoring (Phase E) becomes a no-op
//     (no comparison → no automatic cost-saving reward). The approver can still
//     fire `award_reward` manually, so nothing breaks; the auto-reward just
//     doesn't fire. This is a graceful degradation, not data loss.
//   - Swapping this for an IndexedDB-backed store later requires only changing
//     the bodies of these functions (the call sites in PurchasePanel stay the
//     same), so this seam is intentionally narrow and synchronous-looking.
//
// Keys are `requestId.toString()` (request ids are u64; we keep them as
// `bigint` everywhere to avoid the safe-integer cliff).

/** The structured snapshot data for one side of a purchase request. */
export interface SnapshotSide {
  /** Total price of the chosen offer, in lamports. */
  priceLamports: bigint;
  /** Lamports per gram (or per ml-as-gram) — the exact ranking basis from `compareOffers`. */
  perUnitLamports: bigint;
  /** Human-readable label of the chosen offer (e.g. "Dish soap · 0.03 SOL · 2×500g"). */
  label: string;
  /** Pack size of the chosen offer. */
  packUnits: number;
  /** Unit weight of the chosen offer. */
  unitGrams: number;
}

/** Both sides of a request's best-value picture, either of which may be unset. */
export interface PendingSnapshot {
  requestId: bigint;
  /** The benchmark offer chosen at create time. Absent if the user typed the
   *  snapshot freehand instead of using the compare modal. */
  benchmark?: SnapshotSide;
  /** The actual offer chosen at restock time. Absent until the buyer compares. */
  actual?: SnapshotSide;
  /** Epoch ms of the most recent write to this record. */
  updatedAt: number;
}

/** Module-level store. Keyed by `requestId.toString()`. */
const store = new Map<string, PendingSnapshot>();

function key(requestId: bigint): string {
  return requestId.toString();
}

function touch(requestId: bigint, mutate: (record: PendingSnapshot) => void): PendingSnapshot {
  const k = key(requestId);
  const existing = store.get(k);
  const record: PendingSnapshot = existing ?? { requestId, updatedAt: 0 };
  mutate(record);
  record.updatedAt = Date.now();
  store.set(k, record);
  return record;
}

/**
 * Record the benchmark offer for a request (chosen at create time via the
 * compare modal). Overwrites any prior benchmark for the same request id.
 */
export function setBenchmark(requestId: bigint, side: SnapshotSide): PendingSnapshot {
  return touch(requestId, (record) => {
    record.benchmark = side;
  });
}

/**
 * Record the actual offer for a request (chosen at restock time via the
 * compare modal). Overwrites any prior actual for the same request id.
 */
export function setActual(requestId: bigint, side: SnapshotSide): PendingSnapshot {
  return touch(requestId, (record) => {
    record.actual = side;
  });
}

/** Read the full snapshot record for a request, or `undefined` if none exists. */
export function getSnapshot(requestId: bigint): PendingSnapshot | undefined {
  return store.get(key(requestId));
}

/** Drop the snapshot record for a request (e.g. after the request is closed). */
export function clearSnapshot(requestId: bigint): void {
  store.delete(key(requestId));
}

/** Test-only: clear the entire store. Exported so unit tests get a clean slate. */
export function __clearAllForTests(): void {
  store.clear();
}
