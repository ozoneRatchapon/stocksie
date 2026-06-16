//! `PurchaseRequest` — a single shared shopping-list entry's on-chain proof.
//!
//! One PDA per request, derived as `[PURCHASE_SEED, household, request_id_le]`
//! where `request_id_le` is the household's monotonic counter in little-endian
//! bytes. The PDA is created by `create_purchase_request` and walked through a
//! strict state machine (Feature 2.2 + 3.3):
//!
//! ```text
//!   Pending ──approve──▶ Approved ──confirm_restock──▶ Restocked ──reimburse──▶ Reimbursed
//!     │                       │
//!     └──────reject───────────┴──▶ Rejected      (terminal)
//!                                                Reimbursed (terminal)
//! ```
//!
//! Each transition is gated by a dedicated guard method here so the instruction
//! handlers stay thin and the lifecycle rules live in exactly one place
//! (DRY). Guards return the resolved next `Status` on success so the caller
//! both asserts the precondition and learns the new state in one call.
//!
//! Privacy (Feature 3.5): `item_hash` and `unit_cost_hash` are blake3 digests
//! referencing off-chain detail. The ledger proves *that* a spend was
//! authorized, restocked, and reimbursed — never *what* was bought.

use crate::constants::{HASH_LEN, PURCHASE_SEED};
use crate::error::StocksieError;
use crate::types::Status;
use anchor_lang::prelude::*;

/// Seed-derived purchase request record.
///
/// Seeds: `[PURCHASE_SEED, household.key(), &request_id.to_le_bytes()]`
/// Space : 8 (discriminator) + `PurchaseRequest::INIT_SPACE`
#[account]
#[derive(InitSpace)]
pub struct PurchaseRequest {
    /// Household this request belongs to. Back-reference for cross-account
    /// validation (security: data-matching / has_one-style checks).
    pub household: Pubkey,

    /// Wallet designated as the buyer. Receives the reimbursement once the
    /// request reaches `Reimbursed`. Set at creation; immutable thereafter.
    pub buyer: Pubkey,

    /// Monotonic id within the household. Used in the PDA seed so each request
    /// address is deterministic and replay-safe.
    pub request_id: u64,

    /// Requested spend in lamports. Acts as the reimbursement ceiling: the
    /// actual payout at `reimburse_buyer` may be ≤ this amount if the buyer
    /// spent less, but can never exceed it.
    pub amount_lamports: u64,

    /// blake3 hash of item name + quantity (Feature 2.1 / 3.5). Privacy
    /// reference only — the raw text lives off-chain.
    pub item_hash: [u8; HASH_LEN],

    /// blake3 hash of the best-value recommendation snapshot (Feature 2.3).
    /// Recorded at creation and again at restock (in case the buyer picked a
    /// different package), letting the off-chain engine re-score and award the
    /// cost-saving bonus without storing prices on-chain.
    pub unit_cost_hash: [u8; HASH_LEN],

    /// Current lifecycle state. Mutated only via the `transition_*` guards.
    pub status: Status,

    /// Wallet that approved the spend. `Pubkey::default()` until approval.
    /// Captured for the audit trail (Feature 3.4 — verifiable approvals).
    pub approved_by: Pubkey,

    /// Slot at which the request was approved. `0` until approval. Lets the UI
    /// show "approved N slots ago" without an extra account read.
    pub approved_slot: u64,

    /// Slot at which the buyer confirmed restock. `0` until restocked.
    pub restocked_slot: u64,

    /// Lamports actually paid out at reimbursement. `0` until reimbursed.
    /// Always `≤ amount_lamports`. Guards against double-reimbursement.
    pub reimbursed_amount: u64,

    /// Reward points already granted for this request. Tracked per-request so
    /// each lifecycle reward (low-stock report, restock, full-run) is granted
    /// at most once even if an instruction is retried.
    pub reward_earned: u64,

    /// Canonical bump for this PDA, stored at init.
    pub bump: u8,

    /// Slot at creation. Auditable ordering.
    pub created_slot: u64,
}

impl PurchaseRequest {
    /// Seeds helper used at `init` (constraint) and for re-derivation.
    pub fn seeds<'a>(household: &'a Pubkey, request_id: u64, bump: &'a [u8]) -> Vec<Vec<u8>> {
        // Allocated as Vec<Vec<u8>> so callers can build a &[&[u8]] slice
        // without lifetime gymnastics over a stack-local `to_le_bytes` array.
        vec![
            PURCHASE_SEED.to_vec(),
            household.to_bytes().to_vec(),
            request_id.to_le_bytes().to_vec(),
            bump.to_vec(),
        ]
    }

    // -----------------------------------------------------------------------
    // Lifecycle transition guards (single source of truth for the state machine)
    // -----------------------------------------------------------------------

    /// Transition `Pending → Approved`. Called by `approve_purchase_request`.
    /// Returns the new status on success so the handler can persist + emit.
    pub fn transition_approved(&mut self, now: u64) -> Result<Status> {
        match self.status {
            Status::Pending => {
                self.status = Status::Approved;
                self.approved_slot = now;
                Ok(Status::Approved)
            }
            Status::Approved | Status::Restocked | Status::Reimbursed | Status::Rejected => {
                Err(StocksieError::InvalidStatusTransition.into())
            }
        }
    }

    /// Transition `Pending | Approved → Rejected`. Called by
    /// `reject_purchase_request`. Allowing rejection from `Approved` lets an
    /// approver undo a mistaken approval before the buyer shops.
    pub fn transition_rejected(&mut self) -> Result<Status> {
        match self.status {
            Status::Pending | Status::Approved => {
                self.status = Status::Rejected;
                Ok(Status::Rejected)
            }
            Status::Restocked | Status::Reimbursed | Status::Rejected => {
                Err(StocksieError::InvalidStatusTransition.into())
            }
        }
    }

    /// Transition `Approved → Restocked`. Called by `confirm_restock`, which
    /// verifies the signer is the recorded `buyer` (see instruction handler).
    pub fn transition_restocked(&mut self, now: u64) -> Result<Status> {
        match self.status {
            Status::Approved => {
                self.status = Status::Restocked;
                self.restocked_slot = now;
                Ok(Status::Restocked)
            }
            Status::Pending | Status::Restocked | Status::Reimbursed | Status::Rejected => {
                Err(StocksieError::InvalidStatusTransition.into())
            }
        }
    }

    /// Transition `Restocked → Reimbursed`. Called by `reimburse_buyer`.
    /// Captures the payout amount and rejects any attempt to reimburse more
    /// than the approved ceiling (security: reimbursement accounting).
    pub fn transition_reimbursed(&mut self, lamports: u64) -> Result<Status> {
        match self.status {
            Status::Restocked => {
                if lamports > self.amount_lamports {
                    return Err(StocksieError::ReimbursementExceedsApproved.into());
                }
                if lamports == 0 {
                    return Err(StocksieError::ZeroWithdrawal.into());
                }
                self.reimbursed_amount = lamports;
                self.status = Status::Reimbursed;
                Ok(Status::Reimbursed)
            }
            Status::Reimbursed => Err(StocksieError::AlreadyReimbursed.into()),
            Status::Pending | Status::Approved | Status::Rejected => {
                Err(StocksieError::InvalidStatusTransition.into())
            }
        }
    }

    /// Record that `points` reward were granted against this request, so each
    /// lifecycle reward stage fires at most once per request (idempotent guard
    /// against retried instructions).
    pub fn record_reward_stage(&mut self, points: u64) -> Result<()> {
        self.reward_earned = self
            .reward_earned
            .checked_add(points)
            .ok_or(StocksieError::RewardOverflow)?;
        Ok(())
    }

    /// Convenience predicate — has this request been reimbursed?
    pub fn is_reimbursed(&self) -> bool {
        matches!(self.status, Status::Reimbursed)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn new_request() -> PurchaseRequest {
        PurchaseRequest {
            household: Pubkey::new_unique(),
            buyer: Pubkey::new_unique(),
            request_id: 1,
            amount_lamports: 1_000_000,
            item_hash: [0u8; HASH_LEN],
            unit_cost_hash: [0u8; HASH_LEN],
            status: Status::Pending,
            approved_by: Pubkey::default(),
            approved_slot: 0,
            restocked_slot: 0,
            reimbursed_amount: 0,
            reward_earned: 0,
            bump: 252,
            created_slot: 0,
        }
    }

    #[test]
    fn happy_path_lifecycle() {
        let mut r = new_request();
        assert_eq!(r.transition_approved(100).unwrap(), Status::Approved);
        assert_eq!(r.approved_slot, 100);
        assert_eq!(r.transition_restocked(200).unwrap(), Status::Restocked);
        assert_eq!(r.restocked_slot, 200);
        assert_eq!(
            r.transition_reimbursed(900_000).unwrap(),
            Status::Reimbursed
        );
        assert_eq!(r.reimbursed_amount, 900_000);
        assert!(r.is_reimbursed());
        assert!(r.status.is_terminal());
    }

    #[test]
    fn cannot_skip_approval() {
        let mut r = new_request();
        // Restocking before approval must fail.
        let err = r.transition_restocked(1).unwrap_err();
        assert_eq!(err, StocksieError::InvalidStatusTransition.into());
        // Reimbursing before approval must fail.
        let err = r.transition_reimbursed(1).unwrap_err();
        assert_eq!(err, StocksieError::InvalidStatusTransition.into());
    }

    #[test]
    fn cannot_reimburse_more_than_approved() {
        let mut r = new_request();
        r.transition_approved(1).unwrap();
        r.transition_restocked(2).unwrap();
        let err = r.transition_reimbursed(r.amount_lamports + 1).unwrap_err();
        assert_eq!(err, StocksieError::ReimbursementExceedsApproved.into());
    }

    #[test]
    fn cannot_reimburse_twice() {
        let mut r = new_request();
        r.transition_approved(1).unwrap();
        r.transition_restocked(2).unwrap();
        r.transition_reimbursed(500_000).unwrap();
        let err = r.transition_reimbursed(500_000).unwrap_err();
        assert_eq!(err, StocksieError::AlreadyReimbursed.into());
    }

    #[test]
    fn reject_works_from_pending_or_approved() {
        let mut r = new_request();
        assert_eq!(r.transition_rejected().unwrap(), Status::Rejected);
        assert!(r.status.is_terminal());

        let mut r2 = new_request();
        r2.transition_approved(1).unwrap();
        assert_eq!(r2.transition_rejected().unwrap(), Status::Rejected);
        assert!(r2.status.is_terminal());
    }

    #[test]
    fn cannot_reject_after_restock() {
        let mut r = new_request();
        r.transition_approved(1).unwrap();
        r.transition_restocked(2).unwrap();
        let err = r.transition_rejected().unwrap_err();
        assert_eq!(err, StocksieError::InvalidStatusTransition.into());
    }

    #[test]
    fn record_reward_stage_accumulates() {
        let mut r = new_request();
        r.record_reward_stage(10).unwrap();
        r.record_reward_stage(25).unwrap();
        assert_eq!(r.reward_earned, 35);
    }
}
