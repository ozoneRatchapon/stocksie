"use client";

// useRefresh — a shared "data changed" signal for the Stocksie UI.
//
// The state view (`useHousehold`) needs to refetch the instant a transaction
// confirms, without waiting for the next poll tick. Every instruction panel
// already tracks its own per-form transaction via `useTransaction`, but those
// nonces are local — there is no single source of truth for "any write just
// landed".
//
// This context fills that gap. It exposes:
//
//   - `nonce`  — a monotonic counter that increments whenever `bump()` is
//     called. Pass it to `useHousehold(refreshNonce)` so the data hook refetches
//     on every confirmed transaction.
//   - `bump()` — the signal. Panels call it from their `useTransaction`
//     `onConfirmed` callback (or wherever a write is known to have landed).
//   - `useTransactionWithRefresh()` — a convenience wrapper that binds `bump`
//     to a `useTransaction` instance, so panels can opt into post-write
//     refetching with a single hook call (no manual `onConfirmed` wiring).
//
// The split keeps panels decoupled from the state view: a panel doesn't need
// to know who consumes the refresh signal, and the state view doesn't need to
// know which panels exist. Both depend only on this context.

import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import {
  useTransaction,
  type UseTransactionResult,
} from "@/hooks/useTransaction";

export type RefreshContextValue = {
  /**
   * Monotonic counter incremented on every `bump()` call. Use as a `useEffect`
   * dependency (or pass directly to `useHousehold`) to refetch dependent state
   * immediately after a write. Starts at `0`; the consumer should treat `0` as
   * "no write has happened yet" so an initial mount does not double-fetch.
   */
  nonce: number;
  /**
   * Increment the counter. Idempotent per call (each invocation is one bump).
   * Safe to call multiple times in quick succession — the consumer debounces
   * via React's effect scheduling, and `useHousehold`'s own staleness guard
   * drops redundant in-flight fetches.
   */
  bump: () => void;
};

const RefreshContext = createContext<RefreshContextValue | null>(null);

/**
 * Provider for {@link useRefresh}.
 *
 * Wrap the panel + state-view tree (typically inside `Providers`, after the
 * wallet and household providers) so every panel can `bump()` and the
 * `StateView` can read `nonce` through a single shared signal.
 */
export function RefreshProvider({ children }: { children: ReactNode }) {
  const [nonce, setNonce] = useState(0);

  // `bump` is stable across renders (empty dep array) so callers can list it as
  // a `useEffect` / `useCallback` dependency without churn. The state update
  // uses the functional form so rapid successive bumps all land.
  const bump = useCallback(() => {
    setNonce((n) => n + 1);
  }, []);

  const value = useMemo<RefreshContextValue>(
    () => ({ nonce, bump }),
    [nonce, bump]
  );

  return (
    <RefreshContext.Provider value={value}>{children}</RefreshContext.Provider>
  );
}

/**
 * Read the shared refresh signal.
 *
 * Throws (with a helpful message) when called outside {@link RefreshProvider} —
 * this catches provider-wiring mistakes at first render rather than failing
 * silently with a never-incrementing counter.
 */
export function useRefresh(): RefreshContextValue {
  const ctx = useContext(RefreshContext);
  if (!ctx) {
    throw new Error("useRefresh must be used inside a <RefreshProvider>.");
  }
  return ctx;
}

/**
 * `useTransaction` bound to the shared refresh signal.
 *
 * Identical to {@link useTransaction}, but every confirmed transaction
 * automatically calls `bump()` so the `StateView` (and any other consumer of
 * {@link useRefresh}) refetches immediately. Panels opt in by importing this
 * instead of the bare `useTransaction`:
 *
 * ```ts
 * // before: const tx = useTransaction();
 * import { useTransactionWithRefresh as useTransaction } from '@/hooks/useRefresh';
 * const tx = useTransaction(); // now also bumps the refresh nonce on success
 * ```
 *
 * Returns the full {@link UseTransactionResult} surface — `pending` /
 * `signature` / `error` / `nonce` / `submit` / `reset` — unchanged, so panel
 * code that already destructures those fields needs no other edits.
 *
 * The `bump` is read from a ref-stabilized callback inside the provider, so the
 * returned `submit` identity stays stable across renders (the underlying
 * `useTransaction` already ignores `onConfirmed` identity churn via its own
 * ref, so this is belt-and-suspenders).
 */
export function useTransactionWithRefresh(): UseTransactionResult {
  const { bump } = useRefresh();
  return useTransaction({ onConfirmed: bump });
}
