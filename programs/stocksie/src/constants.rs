//! Stocksie program constants.
//!
//! Centralized seeds, reward schedules, size limits, and magic numbers.
//! Privacy-first design: on-chain state only ever stores hashes of
//! off-chain detail (item names, receipts, reasons), never raw text.

use anchor_lang::prelude::*;

// ---------------------------------------------------------------------------
// PDA seeds
// ---------------------------------------------------------------------------

/// Seed namespace for the `Household` PDA.
///
/// Seeds: `[HOUSEHOLD_SEED, owner_pubkey]`
/// Unique per creator so one wallet can spawn multiple households.
pub const HOUSEHOLD_SEED: &[u8] = b"household";

/// Seed namespace for the `Member` PDA.
///
/// Seeds: `[MEMBER_SEED, household_pubkey, wallet_pubkey]`
/// One membership record per (household, wallet) pair.
pub const MEMBER_SEED: &[u8] = b"member";

/// Seed namespace for the `PurchaseRequest` PDA.
///
/// Seeds: `[PURCHASE_SEED, household_pubkey, request_id_le]`
pub const PURCHASE_SEED: &[u8] = b"purchase";

// ---------------------------------------------------------------------------
// Reward schedule (Feature 2.5 — gamification)
// ---------------------------------------------------------------------------

/// Points awarded when a member reports low stock (creates a purchase request).
/// Encourages proactive "last-one tap" behavior.
pub const REWARD_LOW_STOCK_REPORT: u64 = 10;

/// Points awarded when a buyer completes & confirms a restock.
pub const REWARD_RESTOCK_COMPLETED: u64 = 25;

/// Points awarded for verified cost-saving choices. The proof hash is
/// recorded on-chain; the actual savings figure is computed off-chain by the
/// best-value engine (Feature 2.3).
pub const REWARD_COST_SAVING: u64 = 50;

/// Points awarded for a completed grocery run (full lifecycle: request →
/// approved → restocked → reimbursed).
pub const REWARD_FULL_RUN_COMPLETED: u64 = 15;

// ---------------------------------------------------------------------------
// Size & policy limits
// ---------------------------------------------------------------------------

/// Maximum number of active members per household. Keeps the fixed-size
/// account bounded; verified during `add_member`.
pub const MAX_MEMBERS: u32 = 16;

/// Maximum reimbursement amount in lamports per single request (0.5 SOL).
/// Acts as a circuit breaker; larger spends require multiple requests or an
/// Owner override off the shared vault.
pub const MAX_REIMBURSEMENT_LAMPORTS: u64 = 500_000_000;

/// Minimum actionable request size in lamports (0.0001 SOL). Below this the
/// gas cost dominates the value, so we reject to keep the ledger clean.
pub const MIN_REQUEST_LAMPORTS: u64 = 100_000;

/// Length of a blake3 hash used for privacy-preserving item/receipt/reason
/// references. blake3 is preferred over SHA-256 per project lib conventions.
pub const HASH_LEN: usize = 32;
