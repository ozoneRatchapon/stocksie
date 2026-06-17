'use client';

// useHousehold — read-side data hook for the live Stocksie state view.
//
// Given the household PDA resolved by `useHouseholdContext`, this hook fetches
// the three account families the UI needs to render the live household state:
//
//   - the `Household` account itself (owner, vault balance, member / request
//     counters, total rewards distributed)
//   - every `Member` account in this household (filtered by the `household`
//     back-reference field via a `memcmp` filter on the discriminator-adjacent
//     pubkey)
//   - every `PurchaseRequest` account in this household (same `memcmp` filter
//     against the leading `household` field)
//
// ## Refresh strategy
//
// Three triggers refetch the data, all funneled through a single `fetchData`
// callback so there is one network path to reason about:
//
//   1. **Initial mount / household change** — the household PDA derived from the
//      owner pubkey changes, so the data must be re-read for the new address.
//   2. **Polling** — a fixed-interval poll picks up external writes (e.g. a
//      second browser tab, a CLI airdrop, or another member's transaction). The
//      interval is conservative (1.5s) to respect local RPC rate limits while
//      still feeling live.
//   3. **Write confirmation** — the consumer passes a `refreshNonce` (typically
//      the `nonce` from a `useTransaction` hook) that increments on every
//      confirmed transaction, triggering an immediate refetch so the UI updates
//      the instant the user's own write lands.
//
// ## Error handling
//
// A missing (not-yet-initialized) household is NOT an error — it is the
// expected state before `initialize_household` runs, and the UI renders an
// "initialize your household" hint for it. The hook distinguishes this from a
// real fetch failure by catching the "account not found" path separately.

import { useCallback, useEffect, useRef, useState } from 'react';
import type { PublicKey } from '@solana/web3.js';
import { useConnection } from '@solana/wallet-adapter-react';
import { useProgram, type StocksieProgram } from '@/lib/program';
import { useHouseholdContext } from '@/hooks/useHouseholdContext';

// ---------------------------------------------------------------------------
// Types — mirror the deserialized account shapes emitted by the Anchor client
// ---------------------------------------------------------------------------

/** A member account as returned by `program.account.member.all()`. */
export type MemberAccount = {
  publicKey: PublicKey;
  account: {
    household: PublicKey;
    wallet: PublicKey;
    role: unknown; // Anchor enum object — convert via `roleFromAnchor`
    rewardPoints: { toString(radix?: number): string }; // BN-like
    active: boolean;
    bump: number;
    joinedSlot: { toString(radix?: number): string };
  };
};

/** A purchase-request account as returned by `program.account.purchaseRequest.all()`. */
export type PurchaseRequestAccount = {
  publicKey: PublicKey;
  account: {
    household: PublicKey;
    buyer: PublicKey;
    requestId: { toString(radix?: number): string };
    amountLamports: { toString(radix?: number): string };
    itemHash: number[];
    unitCostHash: number[];
    status: unknown; // Anchor enum object — convert via `statusFromAnchor`
    approvedBy: PublicKey;
    approvedSlot: { toString(radix?: number): string };
    restockedSlot: { toString(radix?: number): string };
    reimbursedAmount: { toString(radix?: number): string };
    rewardEarned: { toString(radix?: number): string };
    bump: number;
    createdSlot: { toString(radix?: number): string };
  };
};

/** The household account returned by `program.account.household.fetch()`. */
export type HouseholdAccount = {
  owner: PublicKey;
  nameHash: number[];
  bump: number;
  memberCount: number;
  requestCounter: { toString(radix?: number): string };
  totalRewardsDistributed: { toString(radix?: number): string };
  vaultBalance: { toString(radix?: number): string };
  createdSlot: { toString(radix?: number): string };
};

export type HouseholdData = {
  /** The household PDA this data corresponds to. */
  address: PublicKey;
  /** The household account, or `null` when it has not been initialized yet. */
  household: HouseholdAccount | null;
  /** All member accounts in this household (excludes closed memberships). */
  members: MemberAccount[];
  /** All purchase-request accounts in this household (excludes closed). */
  requests: PurchaseRequestAccount[];
};

export type UseHouseholdResult = {
  /** True during the initial load (subsequent refetches do not flip this). */
  loading: boolean;
  /** True during any background refetch (polling / post-write). */
  refreshing: boolean;
  /** A fetch error message, or null. A missing household is NOT an error. */
  error: string | null;
  /** The latest data, or null before the first successful load. */
  data: HouseholdData | null;
  /** Imperatively trigger a refetch. No-op when no household is resolved. */
  refetch: () => void;
};

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Polling interval for picking up external writes. Conservative to respect
 *  local RPC rate limits while still feeling live. */
const POLL_INTERVAL_MS = 1500;

/** Filter offset for the `household` field on Member / PurchaseRequest accounts.
 *  Anchor accounts are laid out as `[8-byte discriminator][fields...]`, and both
 *  the Member and PurchaseRequest structs start with `household: Pubkey` (32
 *  bytes), so the household key sits at byte offset 8. */
const HOUSEHOLD_FIELD_OFFSET = 8;

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

/**
 * Fetch and poll the live household / member / purchase-request state.
 *
 * @param refreshNonce Monotonic counter that, when incremented, triggers an
 *   immediate refetch. Pass the `nonce` from a `useTransaction` hook so the UI
 *   updates the instant a confirmed transaction lands.
 */
export function useHousehold(refreshNonce: number = 0): UseHouseholdResult {
  const program = useProgram();
  const { connection } = useConnection();
  const { household } = useHouseholdContext();

  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [data, setData] = useState<HouseholdData | null>(null);

  // Track the in-flight fetch so a slow poll + a concurrent refetch don't race
  // and clobber each other's results. Only the most recent fetch writes state.
  const fetchTokenRef = useRef(0);
  const pendingRef = useRef(false);

  /**
   * Fetch the household + members + requests for the given address.
   *
   * Pure (no React state) — returns the data and lets the caller decide what to
   * do with errors. Centralizing the fetch logic here keeps the effect below
   * small and the polling path identical to the imperative `refetch` path.
   */
  const fetchForAddress = useCallback(
    async (
      prog: StocksieProgram,
      address: PublicKey,
    ): Promise<HouseholdData> => {
      // Use `fetchNullable` for the household so a not-yet-initialized
      // household is reported as `null` (an expected state) rather than thrown
      // as an error. Members / requests use `.all()` with a household filter,
      // which simply returns `[]` when none exist.
      const [householdAccount, memberAccounts, requestAccounts] =
        await Promise.all([
          prog.account.household.fetchNullable(address),
          prog.account.member.all([
            {
              memcmp: {
                offset: HOUSEHOLD_FIELD_OFFSET,
                bytes: address.toBase58(),
              },
            },
          ]),
          prog.account.purchaseRequest.all([
            {
              memcmp: {
                offset: HOUSEHOLD_FIELD_OFFSET,
                bytes: address.toBase58(),
              },
            },
          ]),
        ]);

      return {
        address,
        household: (householdAccount as HouseholdAccount | null) ?? null,
        members: memberAccounts as MemberAccount[],
        requests: requestAccounts as PurchaseRequestAccount[],
      };
    },
    [],
  );

  /**
   * Run a single fetch against the current household, updating state with the
   * result. Honors the staleness token so only the latest caller's result wins.
   *
   * @param isInitial When true, flips `loading` (the first-load flag) instead of
   *   `refreshing` (the background flag).
   */
  const runFetch = useCallback(
    async (address: PublicKey, isInitial: boolean) => {
      if (!program) return;
      // Concurrency guard: a second concurrent fetch is dropped — the in-flight
      // one owns the result slot. This is the belt to the effect-deps suspenders:
      // even if a poll tick fires during a post-write refetch, only one wins.
      if (pendingRef.current) return;

      const myToken = ++fetchTokenRef.current;
      pendingRef.current = true;
      if (isInitial) setLoading(true);
      else setRefreshing(true);
      setError(null);

      try {
        const result = await fetchForAddress(program, address);
        // Stale check: a newer fetch started while we were awaiting — drop ours.
        if (myToken !== fetchTokenRef.current) return;
        setData(result);
      } catch (err) {
        if (myToken !== fetchTokenRef.current) return;
        const message =
          err instanceof Error
            ? err.message
            : typeof err === 'string'
              ? err
              : 'Failed to load household state';
        setError(message);
      } finally {
        if (myToken === fetchTokenRef.current) {
          pendingRef.current = false;
          setLoading(false);
          setRefreshing(false);
        }
      }
    },
    [program, fetchForAddress],
  );

  // --- Effect 1: initial load + household-address change ------------------
  // Re-runs whenever the household PDA or the program instance changes. The
  // `connection` is in deps because a cluster switch should re-read state.
  useEffect(() => {
    if (!program || !household) {
      // No household resolved yet — reset to the empty state so a stale view
      // from a previously-resolved household doesn't linger on screen.
      setData(null);
      setLoading(false);
      setRefreshing(false);
      setError(null);
      return;
    }
    // `loading` flips true only on this path (initial / address change), not on
    // poll or post-write refetches, so the StateView doesn't flash a loader on
    // every refresh tick.
    void runFetch(household, true);
  }, [program, connection, household, runFetch]);

  // --- Effect 2: polling --------------------------------------------------
  // Fixed-interval refetch to pick up external writes. Skipped while no
  // household is resolved. The interval is cleared on unmount / address change.
  useEffect(() => {
    if (!program || !household) return;
    const id = window.setInterval(() => {
      void runFetch(household, false);
    }, POLL_INTERVAL_MS);
    return () => window.clearInterval(id);
  }, [program, household, runFetch]);

  // --- Effect 3: post-write refetch --------------------------------------
  // `refreshNonce` (typically a `useTransaction` `nonce`) increments on every
  // confirmed transaction — trigger an immediate refetch so the user sees their
  // own write land without waiting for the next poll tick. Skip the initial
  // value (0) so mounting the hook doesn't double-fetch alongside Effect 1.
  useEffect(() => {
    if (refreshNonce === 0) return;
    if (!program || !household) return;
    void runFetch(household, false);
  }, [refreshNonce, program, household, runFetch]);

  // Imperative refetch — exposed for ad-hoc refreshes (e.g. a manual "refresh"
  // button in the StateView header).
  const refetch = useCallback(() => {
    if (!program || !household) return;
    void runFetch(household, false);
  }, [program, household, runFetch]);

  return {
    loading,
    refreshing,
    error,
    data,
    refetch,
  };
}
