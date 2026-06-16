//! Stocksie program events — verifiable, privacy-preserving audit trail.
//!
//! Design (Feature 3.4 — verifiable restock & reward events):
//! Every trust-critical state transition emits an on-chain event. Events carry
//! *only* public, auditable fields:
//!   - account pubkeys (household, member, request, approver, buyer)
//!   - numeric proofs (amounts in lamports, reward points, request counters)
//!   - blake3 content hashes (`[u8; 32]`) referencing off-chain detail
//!
//! They NEVER carry raw inventory data (item names, quantities, receipts,
//! consumption patterns). That stays off-chain per the privacy model
//! (Feature 3.5). The ledger is therefore a transparent contribution history
//! without leaking household specifics.
//!
//! Each event maps 1:1 to a lifecycle arrow in the shared shopping registry:
//!
//! ```text
//! HouseholdCreated
//!   └─ MemberAdded (×N)
//!        ├─ FundsDeposited            (fund the shared vault)
//!        ├─ PurchaseCreated           (Last-One Tap / low-stock report)
//!        │    ├─ PurchaseApproved     (Owner/Parent authorizes spend)
//!        │    │    └─ Restocked       (buyer confirms replenishment)
//!        │    │         └─ Reimbursed (vault → buyer SOL transfer)
//!        │    └─ PurchaseRejected     (approver declines, terminal)
//!        ├─ RewardEarned              (gamification loop, Feature 2.5)
//!        ├─ RoleChanged
//!        └─ MemberRemoved
//! ```

use crate::types::{Role, Status};
use anchor_lang::prelude::*;

// ===========================================================================
// Household lifecycle
// ===========================================================================

/// Emitted by `initialize_household`. Marks the birth of a household PDA and
/// its treasury vault. The `name_hash` is a blake3 digest of the off-chain
/// household display name — enough to detect tampering, not enough to recover
/// the plaintext.
#[event]
pub struct HouseholdCreated {
    /// The household PDA that was created (also the SOL vault address).
    pub household: Pubkey,
    /// Wallet that owns the household and vault.
    pub owner: Pubkey,
    /// blake3 hash of the household's display name. Privacy reference only.
    #[index]
    pub name_hash: [u8; 32],
    /// Slot at which the household was created (audit ordering).
    pub slot: u64,
}

/// Emitted by `add_member`. Records onboarding of a wallet under a given role.
#[event]
pub struct MemberAdded {
    pub household: Pubkey,
    pub member: Pubkey,
    /// Role assigned at onboarding. Stored on-chain because role governs every
    /// subsequent access check (Feature 3.3).
    pub role: Role,
    pub slot: u64,
}

/// Emitted by `remove_member`. Deactivation is soft (active=false) so the
/// member's historical reward contributions remain auditable.
#[event]
pub struct MemberRemoved {
    pub household: Pubkey,
    pub member: Pubkey,
    pub slot: u64,
}

/// Emitted by `set_role`. Useful for tracking promotions (Child → Parent) and
/// privilege escalations in the audit log.
#[event]
pub struct RoleChanged {
    pub household: Pubkey,
    pub member: Pubkey,
    pub old_role: Role,
    pub new_role: Role,
    pub slot: u64,
}

// ===========================================================================
// Vault / funds (Feature 2.4 & 3.2)
// ===========================================================================

/// Emitted by `deposit_funds`. Anyone may fund a household; this event is the
/// receipt that a given wallet topped up the shared treasury.
#[event]
pub struct FundsDeposited {
    pub household: Pubkey,
    pub depositor: Pubkey,
    /// Lamports credited to the vault in this deposit.
    pub lamports: u64,
    /// Vault balance immediately after the deposit, for audit reconciliation.
    pub vault_balance: u64,
    pub slot: u64,
}

/// Emitted by `withdraw_funds` (Owner-only emergency drain).
#[event]
pub struct FundsWithdrawn {
    pub household: Pubkey,
    pub owner: Pubkey,
    pub lamports: u64,
    pub vault_balance: u64,
    pub slot: u64,
}

// ===========================================================================
// Purchase request lifecycle (Feature 2.2, 2.1, 3.3)
// ===========================================================================

/// Emitted by `create_purchase_request`. This is the on-chain anchor of the
/// "Last-One Tap" workflow (Feature 2.1): the moment an essential runs out,
/// a member submits a request and the program records a tamper-proof proof.
///
/// `item_hash` references the off-chain item+quantity detail. `unit_cost_hash`
/// is the best-value recommendation proof (Feature 2.3) — it lets the family
/// later verify *which* price-comparison snapshot was used, without storing
/// the prices themselves on-chain.
#[event]
pub struct PurchaseCreated {
    pub household: Pubkey,
    /// The PurchaseRequest PDA.
    pub request: Pubkey,
    /// Wallet designated as the buyer (receives the later reimbursement).
    pub buyer: Pubkey,
    /// Monotonic per-household request id (used in PDA seeds).
    #[index]
    pub request_id: u64,
    /// Requested spend in lamports.
    pub amount: u64,
    /// blake3 hash of item name + quantity. Privacy reference only.
    pub item_hash: [u8; 32],
    /// blake3 hash of the best-value recommendation snapshot.
    pub unit_cost_hash: [u8; 32],
    pub slot: u64,
}

/// Emitted by `approve_purchase_request`. The approver signature is captured
/// by the transaction itself; this event is the declarative audit record.
#[event]
pub struct PurchaseApproved {
    pub household: Pubkey,
    pub request: Pubkey,
    pub buyer: Pubkey,
    /// Wallet that authorized the spend (Owner or Parent only).
    pub approver: Pubkey,
    pub amount: u64,
    pub slot: u64,
}

/// Emitted by `reject_purchase_request`. `reason_hash` lets the UI render a
/// human-readable reason without leaking raw text to chain observers.
#[event]
pub struct PurchaseRejected {
    pub household: Pubkey,
    pub request: Pubkey,
    pub buyer: Pubkey,
    pub approver: Pubkey,
    /// blake3 hash of the (optional) rejection reason. Privacy reference only.
    pub reason_hash: [u8; 32],
    pub slot: u64,
}

/// Emitted by `confirm_restock`. The buyer attests the item is replenished;
/// this unlocks reimbursement. `unit_cost_hash` is included again in case the
/// buyer picked a different package than originally proposed (the off-chain
/// best-value engine can re-score it and award the cost-saving reward).
#[event]
pub struct Restocked {
    pub household: Pubkey,
    pub request: Pubkey,
    pub buyer: Pubkey,
    pub status: Status,
    pub unit_cost_hash: [u8; 32],
    pub slot: u64,
}

/// Emitted by `reimburse_buyer`. This is the actual vault → buyer SOL
/// transfer event. The lamports movement is also visible in account diffs,
/// but emitting it here makes the *intent* (reimbursement for request N)
/// unambiguous in the audit trail.
#[event]
pub struct Reimbursed {
    pub household: Pubkey,
    pub request: Pubkey,
    pub buyer: Pubkey,
    /// Amount actually paid out. May be ≤ the approved amount if the buyer
    /// spent less than the cap.
    pub lamports: u64,
    pub status: Status,
    pub slot: u64,
}

// ===========================================================================
// Rewards (Feature 2.5 — gamification)
// ===========================================================================

/// Emitted whenever a member earns reward points. The `reason_hash` references
/// the off-chain reason (e.g. "chose cheapest roll pack", "completed grocery
/// run", "reported low stock"). The UI maps the hash back to a friendly badge
/// description without revealing it to public chain observers.
#[event]
pub struct RewardEarned {
    pub household: Pubkey,
    pub member: Pubkey,
    /// Points credited in this event.
    pub points: u64,
    /// Member's cumulative reward total after this credit.
    pub total_points: u64,
    /// blake3 hash of the human-readable reason. Privacy reference only.
    #[index]
    pub reason_hash: [u8; 32],
    pub slot: u64,
}
