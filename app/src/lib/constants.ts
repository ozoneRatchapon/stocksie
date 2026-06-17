// Stocksie frontend constants — env-driven RPC config, PDA seed bytes, and the
// reward / size schedule. Mirrors the on-chain `programs/stocksie/src/constants.rs`
// so client-derived PDAs and balance math stay in lock-step with the program.

// ---------------------------------------------------------------------------
// Cluster / RPC (Surfpool localnet by default)
// ---------------------------------------------------------------------------

type Commitment = 'processed' | 'confirmed' | 'finalized';

const envRpc = process.env.NEXT_PUBLIC_RPC_ENDPOINT;
const envCommitment = process.env.NEXT_PUBLIC_RPC_COMMITMENT as Commitment | undefined;
const envProgramId = process.env.NEXT_PUBLIC_PROGRAM_ID;

/** Surfpool local RPC. Surfpool's default localnet endpoint. */
export const RPC_ENDPOINT: string =
  envRpc && envRpc.trim().length > 0 ? envRpc.trim() : 'http://127.0.0.1:8899';

export const RPC_COMMITMENT: Commitment = envCommitment ?? 'confirmed';

/**
 * Stocksie program id. Must match `Anchor.toml` `[programs.localnet] stocksie`
 * and the on-chain `declare_id!` in `programs/stocksie/src/lib.rs`.
 */
export const PROGRAM_ID: string =
  envProgramId && envProgramId.trim().length > 0
    ? envProgramId.trim()
    : 'At2vd5Mqd9xcHRFAZin1VHb6upEsF1GCXoFG19UHsQoj';

// ---------------------------------------------------------------------------
// PDA seeds (mirror `programs/stocksie/src/constants.rs`)
//   household = ["household", owner]
//   member    = ["member",   household, wallet]
//   purchase  = ["purchase", household, request_id_le_bytes]
//
// `TextEncoder` is used (not `Buffer`) so these are safe to reference at module
// load time, before the Buffer polyfill in `components/Providers.tsx` runs.
// ---------------------------------------------------------------------------

const encoder = new TextEncoder();
export const HOUSEHOLD_SEED: Uint8Array = encoder.encode('household');
export const MEMBER_SEED: Uint8Array = encoder.encode('member');
export const PURCHASE_SEED: Uint8Array = encoder.encode('purchase');

// ---------------------------------------------------------------------------
// Reward schedule (Feature 2.5 — gamification)
// `bigint` so 64-bit points never overflow JS safe-integer math.
// ---------------------------------------------------------------------------

export const REWARD_LOW_STOCK_REPORT = 10n;
export const REWARD_RESTOCK_COMPLETED = 25n;
export const REWARD_COST_SAVING = 50n;
export const REWARD_FULL_RUN_COMPLETED = 15n;

// ---------------------------------------------------------------------------
// Size & policy limits (mirror on-chain guards)
// ---------------------------------------------------------------------------

export const MAX_MEMBERS = 16;
export const MAX_REIMBURSEMENT_LAMPORTS = 500_000_000n; // 0.5 SOL circuit breaker
export const MIN_REQUEST_LAMPORTS = 100_000n; // 0.0001 SOL floor
export const HASH_LEN = 32; // blake3 output length

// ---------------------------------------------------------------------------
// Solana unit conversion
// ---------------------------------------------------------------------------

export const LAMPORTS_PER_SOL = 1_000_000_000n;
