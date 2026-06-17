// Display + error-formatting helpers for the Stocksie frontend.
//
// Three concerns, all pure (no React, no Solana RPC):
//   1. Lamports ↔ SOL string conversion using bigint math (float-free, so a
//      0.5 SOL deposit never becomes 499_999_999 lamports).
//   2. PublicKey shortening for compact display (`AbCd…WxYz`).
//   3. Anchor error extraction — pulls the human-readable message out of the
//      `AnchorError` / `ProgramError` shapes thrown by `@anchor-lang/core`,
//      with a generic fallback for wallet / RPC / unknown errors.

import type { PublicKey } from "@solana/web3.js";
import { LAMPORTS_PER_SOL } from "./constants";

/** Structural stand-in for a `bn.js` BN instance — anything with a
 * `toString(radix)` method. Decouples this module from the bn.js type binding
 * (whose `export =` shape trips TS2749 under the default interop settings),
 * while still accepting real BN instances at runtime. */
type BNLike = { toString(radix?: number): string };

// ---------------------------------------------------------------------------
// Lamports ↔ SOL (float-free)
// ---------------------------------------------------------------------------

/** Coerce a `BNLike | bigint | number` lamport value to a plain `bigint`. */
function toBigInt(value: BNLike | bigint | number): bigint {
  if (typeof value === "bigint") return value;
  if (typeof value === "number") return BigInt(value);
  // BN — route through its base-10 string to avoid the unsafe `toNumber()`
  // path for u64 values that exceed Number.MAX_SAFE_INTEGER.
  return BigInt((value as BNLike).toString(10));
}

/**
 * Render a lamport amount as a SOL string with up to 9 fractional digits,
 * trailing zeros trimmed.
 *
 * Examples: 0 → "0"; 1_500_000_000 → "1.5"; 100_000 → "0.0001".
 */
export function lamportsToSol(lamports: BNLike | bigint | number): string {
  const total = toBigInt(lamports);
  if (total === 0n) return "0";
  const whole = total / LAMPORTS_PER_SOL;
  const frac = total % LAMPORTS_PER_SOL;
  if (frac === 0n) return whole.toString();
  const fracStr = frac.toString().padStart(9, "0").replace(/0+$/, "");
  return `${whole.toString()}.${fracStr}`;
}

/** Render a lamport amount with a ` SOL` suffix, for inline display. */
export function formatSol(lamports: BNLike | bigint | number): string {
  return `${lamportsToSol(lamports)} SOL`;
}

/**
 * Parse a user-typed SOL amount (e.g. `"0.5"`, `"1"`, `"0.0001"`) into lamports.
 *
 * String-based to avoid float precision loss — `0.1 * 1e9` in JS yields
 * `100_000_000.00000001`, which would either be rounded silently or rejected
 * on-chain. Rejects negative values, NaN, and inputs with more than 9 decimal
 * places (sub-lamport precision is not representable).
 *
 * Returns `null` when the input is empty or not a valid SOL amount.
 */
export function solToLamports(input: string | number): bigint | null {
  const s = typeof input === "number" ? String(input) : input.trim();
  if (s.length === 0) return null;
  if (!/^\d+(\.\d+)?$/.test(s)) return null;

  const dot = s.indexOf(".");
  let whole: bigint;
  let frac: bigint;
  if (dot === -1) {
    whole = BigInt(s);
    frac = 0n;
  } else {
    whole = dot === 0 ? 0n : BigInt(s.slice(0, dot));
    const fracStr = s.slice(dot + 1);
    if (fracStr.length > 9) return null;
    frac = BigInt(fracStr.padEnd(9, "0"));
  }
  return whole * LAMPORTS_PER_SOL + frac;
}

// ---------------------------------------------------------------------------
// PublicKey shortening
// ---------------------------------------------------------------------------

/**
 * Abbreviate a base58 pubkey to `head…tail` form. Defaults to 4 + 4 chars,
 * matching the Solana ecosystem convention used by explorers and wallets.
 * Returns the input unchanged when it is already shorter than the abbreviated
 * form.
 */
export function shortPubkey(
  pk: PublicKey | string,
  head = 4,
  tail = 4
): string {
  const s = typeof pk === "string" ? pk : pk.toBase58();
  if (s.length <= head + tail + 1) return s;
  return `${s.slice(0, head)}…${s.slice(-tail)}`;
}

// ---------------------------------------------------------------------------
// Anchor error extraction
// ---------------------------------------------------------------------------

/**
 * Pull a single human-readable message out of any error thrown during a
 * Stocksie transaction (or anywhere else).
 *
 * Recognises the two structured error shapes emitted by `@anchor-lang/core`:
 *   - `AnchorError` — framework constraint failures (`{ error: { errorMessage,
 *     errorCode: { code } }, errorLogs, logs }`).
 *   - `ProgramError` — custom `StocksieError` codes returned by the program
 *     (`{ code, msg }`), already translated back to the on-chain message via
 *     the IDL's `errors` table.
 *
 * Falls back to `Error#message`, then `String(err)`, so wallet rejection,
 * RPC downtime, and genuinely unknown failures still surface something useful.
 *
 * Uses structural checks rather than `instanceof` so this module has no runtime
 * dependency on `@anchor-lang/core`'s error classes.
 */
export function extractErrorMessage(err: unknown): string {
  if (err === null || err === undefined) return "Unknown error";
  if (typeof err === "string") return err;

  if (err instanceof Error) {
    // Anchor framework constraint error: a nested `error` object carries the
    // resolved message plus an `errorCode.code` name (e.g. `ConstraintHasOne`).
    const anchorErr = (
      err as unknown as {
        error?: { errorMessage?: string; errorCode?: { code?: string } };
      }
    ).error;
    if (
      anchorErr &&
      typeof anchorErr === "object" &&
      typeof anchorErr.errorMessage === "string" &&
      anchorErr.errorMessage.length > 0
    ) {
      const code = anchorErr.errorCode?.code;
      return code
        ? `${code}: ${anchorErr.errorMessage}`
        : anchorErr.errorMessage;
    }

    // Anchor program error: a translated custom error code → `{ code, msg }`.
    const programErr = err as unknown as { code?: unknown; msg?: unknown };
    if (
      typeof programErr.code === "number" &&
      typeof programErr.msg === "string" &&
      programErr.msg.length > 0
    ) {
      return programErr.msg;
    }

    return err.message || "Unknown error";
  }

  if (typeof err === "object") {
    // Some wallets reject with a plain object / wallet-adapter error carrying
    // `message` or `error.message`. Cover both without assuming the prototype
    // chain.
    const anyErr = err as { message?: unknown; error?: { message?: unknown } };
    if (typeof anyErr.message === "string" && anyErr.message.length > 0) {
      return anyErr.message;
    }
    if (anyErr.error && typeof anyErr.error.message === "string") {
      return anyErr.error.message;
    }
  }

  return String(err);
}
