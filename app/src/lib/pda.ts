import { PublicKey } from '@solana/web3.js';
import { HOUSEHOLD_SEED, MEMBER_SEED, PROGRAM_ID, PURCHASE_SEED } from './constants';

/**
 * Program-derived-address derivation for the Stocksie program.
 *
 * Mirrors `programs/stocksie/src/constants.rs` exactly:
 *   household = ["household", owner]
 *   member    = ["member",   household, wallet]
 *   purchase  = ["purchase", household, request_id_le_bytes (u64, 8 bytes)]
 */

export function programPublicKey(): PublicKey {
  return new PublicKey(PROGRAM_ID);
}

/** Encode a u64 as 8 little-endian bytes (matches on-chain `to_le_bytes()`). */
function u64LeBytes(value: bigint): Uint8Array {
  const out = new Uint8Array(8);
  let v = value;
  for (let i = 0; i < 8; i++) {
    out[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  return out;
}

/** Household + vault PDA: `[HOUSEHOLD_SEED, owner]`. */
export function findHouseholdPda(owner: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [HOUSEHOLD_SEED, owner.toBuffer()],
    programPublicKey(),
  );
}

/** Membership PDA: `[MEMBER_SEED, household, wallet]`. */
export function findMemberPda(household: PublicKey, wallet: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [MEMBER_SEED, household.toBuffer(), wallet.toBuffer()],
    programPublicKey(),
  );
}

/** Purchase-request PDA: `[PURCHASE_SEED, household, request_id_le_bytes]`. */
export function findPurchasePda(
  household: PublicKey,
  requestId: bigint | number,
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [PURCHASE_SEED, household.toBuffer(), u64LeBytes(BigInt(requestId))],
    programPublicKey(),
  );
}
