'use client';

// useTransaction — the transaction-submission wrapper every Stocksie panel uses.
//
// One hook, three pieces of derived state (`pending` / `signature` / `error`),
// one imperative `submit` method, and a confirmation nonce for downstream
// refetch effects. Wraps the `await program.methods.<ix>(...).accountsStrict(
// {...}).rpc()` dance so individual panels never repeat the try/catch /
// loading-flag / error-extraction boilerplate.
//
// ## Concurrency
//
// A panel's submit buttons are disabled while `pending` is true, but a user
// could still fire a second submit via keyboard or a race with a wallet
// popup. `submit` guards with a ref-counted in-flight flag: a second call
// while one is pending is rejected with a typed error and does NOT clobber
// the first call's state. This keeps the `signature`/`error` shown on screen
// matching the transaction the user is actually waiting on.
//
// ## Stale updates
//
// Each `submit` call captures a token; only the most recent call's resolution
// may write state. If a slow tx confirms after the user has already started a
// newer one, the stale confirmation is dropped (its signature is surfaced via
// `onConfirmed` regardless, so it is not lost — just not displayed as the
// "current" result).
//
// ## Stage 5 integration
//
// `nonce` increments on every confirmed transaction, so a `useHousehold` poll
// hook can list it as a `useEffect` dep to refetch immediately after a write
// (without waiting for the next poll tick). `onConfirmed(signature)` is also
// available for imperative post-tx work (e.g. navigating to the new request).

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { TransactionSignature } from '@solana/web3.js';
import { extractErrorMessage } from '@/lib/format';

/** A thunk that builds and sends a transaction, returning its signature. */
export type TransactionThunk = () => Promise<TransactionSignature>;

export type UseTransactionOptions = {
  /**
   * Invoked after a transaction confirms (after `signature` state is set).
   * Use to trigger a state refetch or navigate. Not invoked on error or when
   * the call is dropped as stale — pair with the `nonce` counter if you need
   * a refetch signal that survives stale-drops.
   */
  onConfirmed?: (signature: TransactionSignature) => void;
};

export type UseTransactionResult = {
  /** True while a transaction is awaiting signature + confirmation. */
  pending: boolean;
  /** The most recent confirmed signature, or null. Cleared by `reset`. */
  signature: TransactionSignature | null;
  /** Human-readable error from the most recent failed submit
   *  (`extractErrorMessage` output), or null. Cleared by `reset` / `clearError`. */
  error: string | null;
  /**
   * Monotonic counter incremented on every confirmed transaction. Use as a
   * `useEffect` dependency to refetch dependent state (e.g. the household /
   * member / purchase accounts in `useHousehold`) immediately after a write.
   */
  nonce: number;
  /**
   * Build + send a transaction. Resolves with the signature on success or
   * `null` on failure (the failure message is in `error`). Returns `null`
   * without doing anything if a transaction is already pending.
   */
  submit: (thunk: TransactionThunk) => Promise<TransactionSignature | null>;
  /** Clear `signature` and `error` (does not affect an in-flight tx). */
  reset: () => void;
  /** Clear only `error`. */
  clearError: () => void;
  /** Clear only `signature`. */
  clearSignature: () => void;
};

/**
 * Track a single in-flight transaction's lifecycle and expose its state.
 *
 * ```tsx
 * const tx = useTransaction({ onConfirmed: () => refetch() });
 * const program = useProgram();
 * return (
 *   <Button loading={tx.pending} onClick={() => tx.submit(async () => {
 *     if (!program) throw new Error('Program not loaded');
 *     return program.methods.depositFunds(new BN(1_000_000))
 *       .accountsStrict({ ... })
 *       .rpc();
 *   })}>Deposit</Button>
 * );
 * ```
 */
export function useTransaction(options: UseTransactionOptions = {}): UseTransactionResult {
  const { onConfirmed } = options;

  const [pending, setPending] = useState(false);
  const [signature, setSignature] = useState<TransactionSignature | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);

  // Token used to ignore stale resolutions: each `submit` captures the
  // current value and only writes state if it still matches when the promise
  // settles. Mirrors the standard "ignore stale async" pattern without
  // pulling in an AbortController (which Anchor's `.rpc()` doesn't accept).
  const submitTokenRef = useRef(0);
  // Boolean ref for the in-flight guard. Read inside `submit` without forcing
  // a re-render every time we check it (state would).
  const pendingRef = useRef(false);

  // Keep the latest `onConfirmed` without churning `submit`'s identity: store
  // it in a ref updated on every render. This way `submit` can stay stable
  // (empty dep array) while still calling the freshest callback.
  const onConfirmedRef = useRef(onConfirmed);
  useEffect(() => {
    onConfirmedRef.current = onConfirmed;
  });

  const submit = useCallback(async (
    thunk: TransactionThunk,
  ): Promise<TransactionSignature | null> => {
    // Concurrency guard: a second concurrent submit is rejected without
    // disturbing the in-flight call's state. The caller (panel) typically
    // disables its button while `pending`, but this is the belt to that.
    if (pendingRef.current) {
      const message = 'Another transaction is already in flight.';
      setError(message);
      return null;
    }

    // Claim the slot + stamp a token so a later `submit`'s resolution can't
    // overwrite ours.
    pendingRef.current = true;
    const myToken = ++submitTokenRef.current;

    setPending(true);
    setError(null);

    try {
      const sig = await thunk();
      // Stale check: if a newer submit started while we were awaiting, drop
      // the result. The newer call owns the displayed state.
      if (myToken !== submitTokenRef.current) return sig;
      setSignature(sig);
      setNonce((n) => n + 1);
      // Invoke the freshest onConfirmed (ref, not closure-captured). Wrap in
      // try/catch so a callback error can never surface as a tx failure.
      try {
        onConfirmedRef.current?.(sig);
      } catch {
        // swallow — a misbehaving callback must not corrupt tx state
      }
      return sig;
    } catch (err) {
      // Stale check: same guard as the success path.
      if (myToken !== submitTokenRef.current) return null;
      const message = extractErrorMessage(err);
      setError(message);
      return null;
    } finally {
      // Only release the slot + pending flag if we are still the active call.
      // A newer submit will have flipped its own pending state on entry.
      if (myToken === submitTokenRef.current) {
        pendingRef.current = false;
        setPending(false);
      }
    }
  }, []);

  const reset = useCallback(() => {
    setSignature(null);
    setError(null);
  }, []);

  const clearError = useCallback(() => setError(null), []);
  const clearSignature = useCallback(() => setSignature(null), []);

  return useMemo<UseTransactionResult>(
    () => ({
      pending,
      signature,
      error,
      nonce,
      submit,
      reset,
      clearError,
      clearSignature,
    }),
    [pending, signature, error, nonce, submit, reset, clearError, clearSignature],
  );
}
