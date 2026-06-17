// Account-resolution helpers shared by every Stocksie instruction panel.
//
// The on-chain program derives its three PDA families from explicit seeds
// (see `lib/pda.ts` for the raw `findProgramAddressSync` calls). This module
// layers two conveniences on top:
//
//   1. Single-value accessors that drop the bump (`householdPda`, `memberPda`,
//      `purchasePda`) — panels never need the bump because Anchor stores the
//      canonical bump on-chain at `init` and re-derives it via `seeds` + `bump`
//      constraints.
//   2. A `callerAccounts` bundle for the {household, callerMember, caller,
//      systemProgram} quartet that appears in ~10 of the 14 instructions.
//
// ## Owner vs. caller (the subtle bit)
//
// The household PDA is seeded by the household **owner** (`["household",
// owner]`), NOT by whoever happens to be calling the instruction. A household
// has exactly one owner (set at `initialize_household`) and any number of
// additional members, all of whom transact against the same fixed household
// address.
//
// This means a panel cannot derive the household from the connected wallet
// alone — a non-owner member's wallet would produce the wrong PDA. Instead the
// household is resolved from an explicit **owner pubkey** (tracked by
// `useHouseholdContext`, defaulting to the connected wallet for the
// owner-driven happy path), and the **caller** (the connected wallet) is used
// only to derive that caller's own `Member` PDA.
//
// Every accessor here therefore takes `owner` (for the household) and, where
// relevant, a separate `wallet` (for a member PDA — caller, target, buyer, or
// depositor). When the connected wallet IS the owner these collapse to the
// same key; when it is not, the split keeps derivation correct.

import { PublicKey, SystemProgram } from '@solana/web3.js';
import { findHouseholdPda, findMemberPda, findPurchasePda } from './pda';

/** The System Program address (`111...111`) — appears as `systemProgram` in every `init`-bearing instruction. */
export const SYSTEM_PROGRAM_ID: PublicKey = SystemProgram.programId;

/**
 * Household (and vault) PDA: `["household", owner]`.
 *
 * The household account IS the SOL vault — there is no separate vault account,
 * so this single address is both the program-state anchor and the lamport
 * custodian.
 */
export function householdPda(owner: PublicKey): PublicKey {
  return findHouseholdPda(owner)[0];
}

/**
 * A member PDA: `["member", household, wallet]`.
 *
 * Seed-identical for every role a wallet may hold in a household — caller,
 * target (of add/remove/set_role/award), buyer, or depositor. The on-chain
 * constraints re-check `has_one = household` and (where relevant) `wallet ==
 * <arg>` so a member PDA from household A can never authorize an action in
 * household B.
 */
export function memberPda(household: PublicKey, wallet: PublicKey): PublicKey {
  return findMemberPda(household, wallet)[0];
}

/**
 * A purchase-request PDA: `["purchase", household, request_id_le_bytes]`.
 *
 * `requestId` is the on-chain monotonic counter stored on the request itself.
 * For instructions operating on an *existing* request (approve / reject /
 * confirm restock / close / reimburse) this is the user-selected id; for
 * `create_purchase_request` use {@link nextPurchasePda} instead.
 */
export function purchasePda(household: PublicKey, requestId: bigint | number): PublicKey {
  return findPurchasePda(household, requestId)[0];
}

/**
 * The PDA a **new** `create_purchase_request` will allocate.
 *
 * The on-chain seed uses `request_counter + 1` (the *next* id), which the
 * handler then commits via `Household::next_request_id`. The frontend must
 * therefore read the current `requestCounter` off the household account and
 * pass `counter + 1` here — passing `counter` would derive the wrong address
 * and the `init` would collide with the most recent existing request.
 */
export function nextPurchasePda(household: PublicKey, currentCounter: bigint | number): PublicKey {
  return purchasePda(household, BigInt(currentCounter) + 1n);
}

/**
 * The four accounts that recur across almost every mutating instruction:
 * the household PDA, the caller's `Member` PDA, the caller's wallet, and the
 * system program.
 *
 * `owner` seeds the household; `caller` is the connected wallet (which may or
 * may not be the owner). Together these satisfy the `household` + `callerMember`
 * + `caller` + `systemProgram` slots in `.accountsStrict({...})` for
 * `deposit_funds`, `approve_purchase_request`, `reject_purchase_request`,
 * `close_purchase_request`, `reimburse_buyer`, `award_reward`, and
 * `reward_summary` (with instruction-specific additions layered on by the
 * caller).
 */
export function callerAccounts(owner: PublicKey, caller: PublicKey): {
  household: PublicKey;
  callerMember: PublicKey;
  caller: PublicKey;
  systemProgram: PublicKey;
} {
  const household = householdPda(owner);
  return {
    household,
    callerMember: memberPda(household, caller),
    caller,
    systemProgram: SYSTEM_PROGRAM_ID,
  };
}
