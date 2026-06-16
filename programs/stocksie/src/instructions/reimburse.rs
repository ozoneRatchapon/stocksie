//! Reimbursement instruction — the trust-critical vault → buyer SOL transfer.
//!
//! Covers Feature 2.2 / 3.2 / 3.4: the moment an approver pays the buyer back
//! for a completed restock, closing the purchase lifecycle loop:
//!   - [`reimburse_buyer`] : `Restocked → Reimbursed` + vault SOL transfer
//!     + full-run-completion reward (Feature 2.5).
//!
//! Authority model: the caller is an active Owner/Parent
//! (`caller_member.can_approve()`), *not* the buyer. The buyer does not sign —
//! they are merely the SOL recipient. The buyer's `Member` PDA is therefore
//! derived from the *stored* `request.buyer` pubkey (not from a signer), and
//! the `buyer` account is a plain `UncheckedAccount` whose key must match the
//! recorded buyer. This separation of authorizer (approver) from beneficiary
//! (buyer) is what makes the reimbursement auditable: the approver attests
//! "this spend is legitimate", and the program atomically moves vault SOL to
//! the recorded buyer and grants the completion reward.
//!
//! The lifecycle guard (`Restocked → Reimbursed`) and the reimbursement
//! ceiling (`lamports ≤ request.amount_lamports`) live in
//! [`PurchaseRequest::transition_reimbursed`], so the handler stays thin. The
//! SOL movement is delegated to [`Household::debit_vault`], which performs a
//! direct lamport move (program-owned PDA vault → buyer) with checked
//! arithmetic and a sufficiency guard.

use crate::constants::{MEMBER_SEED, PURCHASE_SEED, REWARD_FULL_RUN_COMPLETED};
use crate::error::StocksieError;
use crate::events::{Reimbursed, RewardEarned};
use crate::instructions::purchase::hash_reason;
use crate::state::{Household, Member, PurchaseRequest};
use crate::types::Status;
use anchor_lang::prelude::*;

// ===========================================================================
// Reward reason string → blake3 `reason_hash` (Feature 3.5 privacy boundary)
// ===========================================================================

/// Reason string for the full-grocery-run-completion reward stage. Hashed with
/// blake3 (via the shared [`crate::instructions::purchase::hash_reason`]
/// helper) to produce the privacy-preserving `reason_hash` on `RewardEarned`.
/// The ledger records *that* a reason existed and a deterministic handle for
/// the UI to map back to a badge description, without ever storing the reason
/// text on chain.
const REASON_FULL_RUN_COMPLETED: &[u8] = b"completed full grocery run";

// ===========================================================================
// reimburse_buyer
// ===========================================================================

/// Accounts for [`reimburse_buyer`].
///
/// The caller is the *approver* (Owner/Parent), not the buyer. The buyer's
/// `Member` PDA is therefore seeded from the **stored** `request.buyer` (not a
/// signer), and `buyer` is a plain `UncheckedAccount` whose key must match the
/// recorded buyer. Field order matters: `request` precedes `buyer_member` so
/// that `request.buyer` is available when `buyer_member`'s seeds are evaluated
/// during account validation.
#[derive(Accounts)]
pub struct ReimburseBuyer<'info> {
    /// Household + vault PDA. Mutated: debited via `debit_vault` (lamports out
    /// to the buyer) and `total_rewards_distributed` accumulates the full-run
    /// completion reward.
    #[account(mut)]
    pub household: Account<'info, Household>,

    /// Caller's membership — the approve gate. Seeds bind it to `household` +
    /// `caller`; `has_one` re-verifies the back-reference; `active` blocks
    /// deactivated members; `can_approve()` admits Owner/Parent only. The
    /// approver need not be the same wallet that approved originally.
    #[account(
        seeds = [MEMBER_SEED, household.key().as_ref(), caller.key().as_ref()],
        bump,
        has_one = household,
        constraint = caller_member.active @ StocksieError::MemberInactive,
        constraint = caller_member.can_approve() @ StocksieError::UnauthorizedRole,
    )]
    pub caller_member: Account<'info, Member>,

    /// The request PDA. Seeded by the stored `request_id` with the stored
    /// canonical bump (standard re-derivation idiom for non-init PDAs, matching
    /// `confirm_restock` / `close_purchase_request`). `has_one = household`
    /// binds it to this household (cross-cutting rule #4).
    #[account(
        mut,
        seeds = [
            PURCHASE_SEED,
            household.key().as_ref(),
            request.request_id.to_le_bytes().as_ref(),
        ],
        bump = request.bump,
        has_one = household,
    )]
    pub request: Account<'info, PurchaseRequest>,

    /// Buyer's membership — `mut` because the buyer earns the full-run
    /// completion reward. Seeded by the **stored** `request.buyer` pubkey
    /// (NOT a signer: in reimbursement the caller is the approver, and the
    /// buyer is merely the SOL recipient). `has_one` binds it to this
    /// household (cross-cutting rule #4); `active` blocks a deactivated buyer;
    /// the wallet-equality constraint is defense-in-depth (the seed already
    /// derives the correct PDA, so this guards against data corruption).
    #[account(
        mut,
        seeds = [MEMBER_SEED, household.key().as_ref(), request.buyer.as_ref()],
        bump,
        has_one = household,
        constraint = buyer_member.active @ StocksieError::MemberInactive,
        constraint = buyer_member.wallet == request.buyer @ StocksieError::NotBuyer,
    )]
    pub buyer_member: Account<'info, Member>,

    /// CHECK: This is the SOL reimbursement recipient — the wallet that the
    /// recorded `request.buyer` points at. It is intentionally not a typed
    /// account: in `reimburse_buyer`, the caller is the *approver* (Owner/
    /// Parent) and the buyer merely *receives* lamports, so the buyer neither
    /// signs nor needs to own any program state. The two safety properties
    /// that matter are enforced inline:
    ///   1. The address is bound to the request's recorded buyer via the
    ///      `constraint = buyer.key() == request.buyer @ StocksieError::NotBuyer`
    ///      check below — an attacker cannot redirect the payout to any other
    ///      wallet.
    ///   2. `buyer_member` (the Member PDA seeded from the *stored*
    ///      `request.buyer`) and `request.buyer == buyer.key()` together prove
    ///      the recipient is an active member of this household whose wallet
    ///      matches the recorded buyer — i.e. the recipient is exactly who the
    ///      request says shopped.
    ///
    /// Lamports are only *credited* here (by `Household::debit_vault`), never
    /// read, so there is no data-deserialization trust either.
    #[account(
        mut,
        constraint = buyer.key() == request.buyer @ StocksieError::NotBuyer,
    )]
    pub buyer: UncheckedAccount<'info>,

    /// The authorizing approver (Owner/Parent).
    pub caller: Signer<'info>,
}

/// Handler for `reimburse_buyer(lamports)`.
///
/// The trust-critical moment: the vault pays the buyer back, moving
/// `Restocked → Reimbursed` and transferring `lamports` SOL in the same atomic
/// instruction.
///
/// Business rules enforced here (not expressible as constraints):
///   - The lifecycle transition is delegated to
///     [`PurchaseRequest::transition_reimbursed`], which rejects over-ceiling
///     payouts (`lamports > request.amount_lamports`), zero payouts, and any
///     call from a non-`Restocked` state (making double-reimbursement
///     impossible).
///   - The SOL movement is delegated to [`Household::debit_vault`], which
///     performs a direct lamport move from the program-owned vault PDA to the
///     buyer (a PDA cannot be a system-program signer, so this is the canonical
///     vault-debit pattern), re-checks zero + sufficiency + alias internally,
///     and mirrors `vault_balance` with checked arithmetic.
///
/// Order matters: the transition guard runs FIRST so a failed validation
/// aborts before any SOL moves. Solana's transaction atomicity then guarantees
/// that a failed `debit_vault` (insufficient vault funds) or a `RewardOverflow`
/// rolls back the status mutation and the SOL movement too.
///
/// Rewards the buyer with `REWARD_FULL_RUN_COMPLETED` (Feature 2.5), recording
/// the stage on the request, the member, and the household accumulators (audit
/// triangle — the test suite asserts the reconciliation invariants).
///
/// Emits [`Reimbursed`], then [`RewardEarned`] (reason: full run completed).
pub fn reimburse_buyer_handler(ctx: Context<ReimburseBuyer>, lamports: u64) -> Result<()> {
    // Capture immutable snapshots before any mutable borrows (mirrors the
    // pattern in `create_purchase_request_handler` / `confirm_restock_handler`
    // so the `emit!` calls never alias a live `&mut self` borrow).
    let household_key = ctx.accounts.household.key();
    let request_key = ctx.accounts.request.key();
    let buyer_key = ctx.accounts.buyer.key();
    let clock = Clock::get()?;

    // 1. Validate the lifecycle transition FIRST: rejects over-ceiling payouts,
    //    zero payouts, and any call from a non-`Restocked` state (double-
    //    reimbursement guard). Failing here aborts before any SOL moves.
    ctx.accounts.request.transition_reimbursed(lamports)?;

    // 2. Move SOL from the program-owned vault PDA to the buyer. `debit_vault`
    //    does a direct lamport move (PDAs cannot be system-program signers, so
    //    `system_program::transfer` is not an option here) and re-checks zero,
    //    sufficiency, and vault≠destination alias internally. Extract the
    //    `AccountInfo`s first so the `&mut self` borrow on `household` does not
    //    alias an inline `to_account_info()` call (mirrors `withdraw_funds`).
    let vault_info = ctx.accounts.household.to_account_info();
    let buyer_info = ctx.accounts.buyer.to_account_info();
    ctx.accounts
        .household
        .debit_vault(&vault_info, &buyer_info, lamports)?;

    // 3. Reward the buyer for completing the full grocery run (Feature 2.5).
    //    Three accumulators move so the audit triangle (member / request /
    //    household) never diverges — the test suite asserts the reconciliation
    //    invariants. A `RewardOverflow` here would revert the SOL move above
    //    via Solana's transaction atomicity.
    let reward = REWARD_FULL_RUN_COMPLETED;
    ctx.accounts.buyer_member.add_reward(reward)?;
    ctx.accounts.request.record_reward_stage(reward)?;
    ctx.accounts.household.record_rewards(reward)?;

    emit!(Reimbursed {
        household: household_key,
        request: request_key,
        buyer: buyer_key,
        lamports,
        status: Status::Reimbursed,
        slot: clock.slot,
    });
    emit!(RewardEarned {
        household: household_key,
        member: buyer_key,
        points: reward,
        total_points: ctx.accounts.buyer_member.reward_points,
        reason_hash: hash_reason(REASON_FULL_RUN_COMPLETED),
        slot: clock.slot,
    });
    Ok(())
}

// ===========================================================================
// Tests
// ===========================================================================

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::Role;

    /// The reimbursement authority gate is `can_approve()` (Owner/Parent) —
    /// the same predicate encoded in the `caller_member` constraint. Asserting
    /// it here keeps the instruction-level policy honest against future `Role`
    /// edits. (The state-level transition guards — over-ceiling, zero, double-
    /// reimburse — are exercised in `state/purchase_request.rs`.)
    #[test]
    fn reimburse_authority_is_approve_gate() {
        assert!(Role::Owner.can_approve());
        assert!(Role::Parent.can_approve());
        assert!(!Role::Child.can_approve());
        assert!(!Role::Guest.can_approve());
    }

    /// The full-run-completion reward `reason_hash` must be deterministic and
    /// nonzero so the audit stream can unambiguously map a `RewardEarned` event
    /// to its badge description.
    #[test]
    fn full_run_reason_hash_is_deterministic_and_nonzero() {
        let h = hash_reason(REASON_FULL_RUN_COMPLETED);
        assert_ne!(h, [0u8; 32]);
        // Determinism: same input → same output.
        assert_eq!(h, hash_reason(REASON_FULL_RUN_COMPLETED));
    }
}
