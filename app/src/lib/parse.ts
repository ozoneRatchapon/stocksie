// Shared parsing helpers for the Stocksie instruction panels.
//
// Two pure, null-on-failure parsers that every panel form needs:
//
//   - `tryParsePublicKey` : turn a user-typed base58 string into a `PublicKey`,
//     returning `null` on empty / invalid input instead of throwing. Used by
//     every form that takes a wallet address (add_member, remove_member,
//     set_role, create_purchase_request's buyer, confirm_restock's buyer,
//     reimburse_buyer's buyer, award_reward's target).
//   - `tryParseUint64`    : turn a user-typed integer string into a `bigint`,
//     returning `null` on empty / non-numeric / overflow input. Used by every
//     form that takes a request id or a point count.
//
// Both return `null` for empty input (rather than an error) so a panel can
// distinguish "user hasn't typed anything yet" (no error, just disable submit)
// from "user typed something invalid" (show an error). This keeps the form UX
// calm — no red error flash while the field is still empty.
//
// Extracted here from the four panel files that previously each carried their
// own identical copies (DRY). The behavior is byte-for-byte identical to the
// inlined versions, so the panels swap to these with no other code changes.

import { PublicKey } from "@solana/web3.js";

/**
 * Parse a base58 string into a `PublicKey`, returning `null` on failure.
 *
 * - Empty / whitespace-only input → `null` (treated as "not yet entered").
 * - Any `PublicKey` constructor throw (invalid base58, wrong length, bad
 *   checksum) → `null` (treated as "invalid").
 *
 * Never throws — panels call this inside `useMemo` over the raw input string,
 * so a throwing parse would surface as an unhandled React error. The null
 * return lets the panel compute a sibling `error` string via a separate
 * validation memo.
 */
export function tryParsePublicKey(input: string): PublicKey | null {
  const trimmed = input.trim();
  if (trimmed.length === 0) return null;
  try {
    return new PublicKey(trimmed);
  } catch {
    return null;
  }
}

/**
 * Parse a non-negative integer string into a `bigint`, returning `null` on
 * failure.
 *
 * - Empty / whitespace-only input → `null`.
 * - Any non-digit character (signs, decimals, exponents, commas) → `null`.
 *   The program's request ids and point counts are whole numbers; rejecting
 *   decimals up front avoids a confusing on-chain `InvalidArgument` later.
 * - Overflow of the JS `BigInt` range → `null` (defensive; in practice the
 *   values are u64 request ids / point counts, which fit comfortably).
 *
 * Returns a `bigint` (or `null` on empty/invalid input — not a `number`) so callers never hit the
 * `Number.MAX_SAFE_INTEGER` cliff when feeding the value into a `new BN(...)`
 * instruction arg via `.toString()`.
 */
export function tryParseUint64(input: string): bigint | null {
  const trimmed = input.trim();
  if (trimmed.length === 0) return null;
  // Strict non-negative integer: only digits, optional leading zeros. Rejects
  // `+1`, `-1`, `1.5`, `1e3`, `1_000`, ` 1 ` (trimmed already), `0x10`.
  if (!/^\d+$/.test(trimmed)) return null;
  try {
    return BigInt(trimmed);
  } catch {
    return null;
  }
}
