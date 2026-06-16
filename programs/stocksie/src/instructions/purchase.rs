//! Purchase-lifecycle instructions — the shared shopping list as a state machine.
//!
//! Covers Features 2.1 (Last-One Tap), 2.2 (approval workflow), and 3.3
//! (access-controlled state transitions). Five handlers walk a
//! `PurchaseRequest` through its lifecycle:
//!   - [`create_purchase_request`]  : `→ Pending`   (any active transacting member)
//!   - [`approve_purchase_request`] : `Pending → Approved`     (Owner/Parent, ≠ buyer)
//!   - [`reject_purchase_request`]  : `Pending|Approved → Rejected` (terminal)
//!   - [`confirm_restock`]          : `Approved → Restocked`   (the recorded buyer only)
//!   - [`close_purchase_request`]   : drain a terminal request's rent
//!
//! Authority model: every mutating op loads the caller's `Member` PDA (seeds +
//! `has_one`) and applies the documented role gate (`can_transact` / `can_approve`
//! / buyer-equality). The strict status transitions themselves are *not* encoded
//! here — they live in [`PurchaseRequest::transition_*`] so the state machine
//! has exactly one definition (DRY). Handlers stay thin: validate args, call the
//! relevant `transition_*`, mutate, emit.
//!
//! Counter-based PDA seed (state-machine doc §6): the `PurchaseRequest` PDA is
//! seeded `[PURCHASE_SEED, household, &request_id.to_le_bytes()]` where
//! `request_id = household.request_counter + 1`. Because Anchor resolves `init`
//! seeds during account validation (before the handler runs), the seed reads the
//! *current* counter and adds 1; the handler's [`Household::next_request_id`]
//! then increments the counter to exactly that value, keeping the derived
//! address and the stored `request_id` provably consistent (first id is `1`).

use crate::constants::{
    MAX_REIMBURSEMENT_LAMPORTS, MEMBER_SEED, MIN_REQUEST_LAMPORTS, PURCHASE_SEED,
    REWARD_LOW_STOCK_REPORT, REWARD_RESTOCK_COMPLETED,
};
use crate::error::StocksieError;
use crate::events::{PurchaseApproved, PurchaseCreated, PurchaseRejected, Restocked, RewardEarned};
use crate::state::{Household, Member, PurchaseRequest};
use crate::types::{Role, Status};
use anchor_lang::prelude::*;

// ===========================================================================
// Reward reason strings → blake3 `reason_hash` (Feature 3.5 privacy boundary)
// ===========================================================================

/// Reason string for the low-stock-report reward stage. Hashed with blake3 at
/// emit time to produce the privacy-preserving `reason_hash` on `RewardEarned`.
const REASON_LOW_STOCK: &[u8] = b"reported low stock";

/// Reason string for the restock-completion reward stage.
const REASON_RESTOCK: &[u8] = b"completed restock";

/// blake3 of a human-readable reward reason → 32-byte privacy reference.
///
/// Matches the `RewardEarned.reason_hash` contract: the ledger records *that*
/// a reason existed and a deterministic handle for the UI to map back to a
/// badge description, without ever storing the reason text on chain.
fn hash_reason(reason: &[u8]) -> [u8; 32] {
    *blake3::hash(reason).as_bytes()
}

// ===========================================================================
// create_purchase_request
// ===========================================================================

/// Accounts for [`create_purchase_request`].
///
/// The `request` PDA is seeded from `household.request_counter + 1` (the next
/// id). Anchor derives this during validation, so the seed reads the counter
/// *before* the handler increments it; the handler then calls
/// `next_request_id()`, landing the counter on exactly the seed value. This
/// keeps the derived address and the stored `request_id` consistent and yields
/// a first id of `1` (counter starts at `0`).
///
/// `buyer_member` is loaded (not mutated) purely to *prove* the named buyer is
/// a real, active, transacting member of this household — a stranger wallet
/// cannot be named as the buyer.
#[derive(Accounts)]
#[instruction(amount_lamports: u64, item_hash: [u8; 32], unit_cost_hash: [u8; 32], buyer: Pubkey)]
pub struct CreatePurchaseRequest<'info> {
    /// Household + vault PDA. Mutated: `request_counter` increments and
    /// `total_rewards_distributed` accumulates the reporter reward.
    #[account(mut)]
    pub household: Account<'info, Household>,

    /// Caller's membership — the transact gate. `mut` because the reporter
    /// earns the low-stock reward here. Seeds bind it to `household` +
    /// `caller`; `has_one` re-verifies the back-reference; `can_transact()`
    /// admits Owner/Parent/Child and excludes Guest.
    #[account(
        mut,
        seeds = [MEMBER_SEED, household.key().as_ref(), caller.key().as_ref()],
        bump,
        has_one = household,
        constraint = caller_member.active @ StocksieError::MemberInactive,
        constraint = caller_member.can_transact() @ StocksieError::UnauthorizedRole,
    )]
    pub caller_member: Account<'info, Member>,

    /// The new request PDA. Seeded by the *next* request id (`counter + 1`),
    /// which the handler then commits via `next_request_id()`. `init` rejects
    /// a duplicate create (PDA collision) — no `init_if_needed` is used or
    /// needed.
    #[account(
        init,
        seeds = [
            PURCHASE_SEED,
            household.key().as_ref(),
            household.request_counter.wrapping_add(1).to_le_bytes().as_ref(),
        ],
        bump,
        payer = caller,
        space = 8 + PurchaseRequest::INIT_SPACE,
    )]
    pub request: Account<'info, PurchaseRequest>,

    /// Buyer's membership — proves the named `buyer` is a real, active,
    /// transacting member of this household. Read-only: the buyer earns their
    /// rewards later (at `confirm_restock` / `reimburse_buyer`).
    #[account(
        seeds = [MEMBER_SEED, household.key().as_ref(), buyer.as_ref()],
        bump,
        has_one = household,
        constraint = buyer_member.active @ StocksieError::MemberInactive,
        constraint = buyer_member.can_transact() @ StocksieError::UnauthorizedRole,
    )]
    pub buyer_member: Account<'info, Member>,

    /// Caller. Pays rent for the new `PurchaseRequest` PDA.
    #[account(mut)]
    pub caller: Signer<'info>,

    pub system_program: Program<'info, System>,
}

/// Handler for `create_purchase_request(amount_lamports, item_hash, unit_cost_hash, buyer)`.
///
/// Business rules enforced here (not expressible as constraints):
///   - `MIN_REQUEST_LAMPORTS ≤ amount_lamports ≤ MAX_REIMBURSEMENT_LAMPORTS`.
///   - `request_id` is assigned via [`Household::next_request_id`], which
///     matches the `(counter + 1)` value used to derive the PDA at validation.
///
/// Rewards the reporter with `REWARD_LOW_STOCK_REPORT`, recording the stage on
/// the request, the member, and the household accumulators (audit triangle).
///
/// Emits [`PurchaseCreated`], then [`RewardEarned`] (reason: low-stock report).
pub fn create_purchase_request_handler(
    ctx: Context<CreatePurchaseRequest>,
    amount_lamports: u64,
    item_hash: [u8; 32],
    unit_cost_hash: [u8; 32],
    buyer: Pubkey,
) -> Result<()> {
    // Range-check the requested spend ceiling.
    if amount_lamports < MIN_REQUEST_LAMPORTS {
        return Err(StocksieError::AmountBelowMinimum.into());
    }
    if amount_lamports > MAX_REIMBURSEMENT_LAMPORTS {
        return Err(StocksieError::AmountExceedsMaximum.into());
    }

    // Capture immutable snapshots before any mutable borrows.
    let household_key = ctx.accounts.household.key();
    let caller_key = ctx.accounts.caller.key();
    let request_key = ctx.accounts.request.key();
    let request_bump = ctx.bumps.request;
    let clock = Clock::get()?;

    // Assign the next monotonic id. This increments `request_counter` to
    // exactly the value (`counter + 1`) the seed was derived from, so the
    // stored `request_id` and the PDA address are provably consistent.
    let request_id = ctx.accounts.household.next_request_id()?;

    {
        let request = &mut ctx.accounts.request;
        request.household = household_key;
        request.buyer = buyer;
        request.request_id = request_id;
        request.amount_lamports = amount_lamports;
        request.item_hash = item_hash;
        request.unit_cost_hash = unit_cost_hash;
        request.status = Status::Pending;
        request.approved_by = Pubkey::default();
        request.approved_slot = 0;
        request.restocked_slot = 0;
        request.reimbursed_amount = 0;
        request.reward_earned = 0;
        request.bump = request_bump;
        request.created_slot = clock.slot;
    }

    // Reward the reporter for the low-stock report (Feature 2.5). Three
    // accumulators move so the audit triangle (member / request / household)
    // never diverges — the test suite asserts the reconciliation invariants.
    let reward = REWARD_LOW_STOCK_REPORT;
    ctx.accounts.caller_member.add_reward(reward)?;
    ctx.accounts.request.record_reward_stage(reward)?;
    ctx.accounts.household.record_rewards(reward)?;

    emit!(PurchaseCreated {
        household: household_key,
        request: request_key,
        buyer,
        request_id,
        amount: amount_lamports,
        item_hash,
        unit_cost_hash,
        slot: clock.slot,
    });
    emit!(RewardEarned {
        household: household_key,
        member: caller_key,
        points: reward,
        total_points: ctx.accounts.caller_member.reward_points,
        reason_hash: hash_reason(REASON_LOW_STOCK),
        slot: clock.slot,
    });
    Ok(())
}

// ===========================================================================
// approve_purchase_request
// ===========================================================================

/// Accounts for [`approve_purchase_request`].
///
/// `request` is re-derived from its stored `request_id` + canonical `bump`
/// (the standard "PDA re-derivation from its own stored counter + bump"
/// idiom), with `has_one = household` preventing cross-household confusion.
#[derive(Accounts)]
pub struct ApprovePurchaseRequest<'info> {
    /// Read-only household reference. Approval touches no household field.
    pub household: Account<'info, Household>,

    /// Caller's membership — the approve gate. `can_approve()` admits
    /// Owner/Parent and excludes Child/Guest.
    #[account(
        seeds = [MEMBER_SEED, household.key().as_ref(), caller.key().as_ref()],
        bump,
        has_one = household,
        constraint = caller_member.active @ StocksieError::MemberInactive,
        constraint = caller_member.can_approve() @ StocksieError::UnauthorizedRole,
    )]
    pub caller_member: Account<'info, Member>,

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

    /// The approver (Owner/Parent) wallet.
    pub caller: Signer<'info>,
}

/// Handler for `approve_purchase_request()`.
///
/// Enforces separation of duties: the approver must not be the buyer
/// (`SelfApprovalForbidden`). This applies even to the Owner — the only way to
/// authorize your own spend is a two-transaction flow, never a single call.
///
/// The actual `Pending → Approved` transition (including rejection of an
/// already-`Approved` request) is delegated to
/// [`PurchaseRequest::transition_approved`].
///
/// Emits [`PurchaseApproved`].
pub fn approve_purchase_request_handler(ctx: Context<ApprovePurchaseRequest>) -> Result<()> {
    // Separation of duties: an approver cannot authorize their own request.
    if ctx.accounts.request.buyer == ctx.accounts.caller.key() {
        return Err(StocksieError::SelfApprovalForbidden.into());
    }

    let clock = Clock::get()?;
    let household_key = ctx.accounts.household.key();
    let request_key = ctx.accounts.request.key();
    let caller_key = ctx.accounts.caller.key();
    let buyer = ctx.accounts.request.buyer;
    let amount = ctx.accounts.request.amount_lamports;

    ctx.accounts.request.transition_approved(clock.slot)?;
    ctx.accounts.request.approved_by = caller_key;

    emit!(PurchaseApproved {
        household: household_key,
        request: request_key,
        buyer,
        approver: caller_key,
        amount,
        slot: clock.slot,
    });
    Ok(())
}

// ===========================================================================
// reject_purchase_request
// ===========================================================================

/// Accounts for [`reject_purchase_request`]. Same shape as
/// [`ApprovePurchaseRequest`].
#[derive(Accounts)]
#[instruction(reason_hash: [u8; 32])]
pub struct RejectPurchaseRequest<'info> {
    pub household: Account<'info, Household>,

    #[account(
        seeds = [MEMBER_SEED, household.key().as_ref(), caller.key().as_ref()],
        bump,
        has_one = household,
        constraint = caller_member.active @ StocksieError::MemberInactive,
        constraint = caller_member.can_approve() @ StocksieError::UnauthorizedRole,
    )]
    pub caller_member: Account<'info, Member>,

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

    pub caller: Signer<'info>,
}

/// Handler for `reject_purchase_request(reason_hash)`.
///
/// Allowed from `Pending` *or* `Approved` (an approver can undo a mistaken
/// approval before the buyer shops). Terminal. The `reason_hash` is a blake3
/// digest of an optional off-chain reason; clients may pass `[0; 32]` to
/// denote "no reason given".
///
/// Emits [`PurchaseRejected`].
pub fn reject_purchase_request_handler(
    ctx: Context<RejectPurchaseRequest>,
    reason_hash: [u8; 32],
) -> Result<()> {
    let clock = Clock::get()?;
    let household_key = ctx.accounts.household.key();
    let request_key = ctx.accounts.request.key();
    let buyer = ctx.accounts.request.buyer;
    let caller_key = ctx.accounts.caller.key();

    ctx.accounts.request.transition_rejected()?;

    emit!(PurchaseRejected {
        household: household_key,
        request: request_key,
        buyer,
        approver: caller_key,
        reason_hash,
        slot: clock.slot,
    });
    Ok(())
}

// ===========================================================================
// confirm_restock
// ===========================================================================

/// Accounts for [`confirm_restock`].
///
/// Only the recorded buyer may confirm. The buyer's `Member` PDA is seeded by
/// the `buyer` signer, and two defense-in-depth data-matches pin the request
/// to that same wallet: `request.buyer == buyer_member.wallet` and
/// `request.buyer == buyer.key()`. A non-buyer cannot pass either.
#[derive(Accounts)]
pub struct ConfirmRestock<'info> {
    /// Household + vault PDA. Mutated: `total_rewards_distributed` accumulates
    /// the restock-completion reward.
    #[account(mut)]
    pub household: Account<'info, Household>,

    /// Buyer's membership — `mut` because the buyer earns the restock reward.
    /// `active` is required so a deactivated buyer cannot confirm.
    #[account(
        mut,
        seeds = [MEMBER_SEED, household.key().as_ref(), buyer.key().as_ref()],
        bump,
        has_one = household,
        constraint = buyer_member.active @ StocksieError::MemberInactive,
    )]
    pub buyer_member: Account<'info, Member>,

    #[account(
        mut,
        seeds = [
            PURCHASE_SEED,
            household.key().as_ref(),
            request.request_id.to_le_bytes().as_ref(),
        ],
        bump = request.bump,
        has_one = household,
        constraint = request.buyer == buyer_member.wallet @ StocksieError::NotBuyer,
        constraint = request.buyer == buyer.key() @ StocksieError::NotBuyer,
    )]
    pub request: Account<'info, PurchaseRequest>,

    /// The recorded buyer. Must equal `request.buyer`.
    pub buyer: Signer<'info>,
}

/// Handler for `confirm_restock(unit_cost_hash)`.
///
/// The buyer attests the item is replenished, moving `Approved → Restocked`.
/// The `unit_cost_hash` is overwritten with the actual-purchase snapshot so
/// the off-chain best-value engine (Feature 2.3) can re-score and later award
/// the cost-saving bonus — prices themselves are never stored on chain.
///
/// Rewards the buyer with `REWARD_RESTOCK_COMPLETED`.
///
/// Emits [`Restocked`], then [`RewardEarned`] (reason: restock completed).
pub fn confirm_restock_handler(
    ctx: Context<ConfirmRestock>,
    unit_cost_hash: [u8; 32],
) -> Result<()> {
    let clock = Clock::get()?;
    let household_key = ctx.accounts.household.key();
    let request_key = ctx.accounts.request.key();
    let buyer_key = ctx.accounts.buyer.key();

    ctx.accounts.request.transition_restocked(clock.slot)?;
    ctx.accounts.request.unit_cost_hash = unit_cost_hash;

    let reward = REWARD_RESTOCK_COMPLETED;
    ctx.accounts.buyer_member.add_reward(reward)?;
    ctx.accounts.request.record_reward_stage(reward)?;
    ctx.accounts.household.record_rewards(reward)?;

    emit!(Restocked {
        household: household_key,
        request: request_key,
        buyer: buyer_key,
        status: Status::Restocked,
        unit_cost_hash,
        slot: clock.slot,
    });
    emit!(RewardEarned {
        household: household_key,
        member: buyer_key,
        points: reward,
        total_points: ctx.accounts.buyer_member.reward_points,
        reason_hash: hash_reason(REASON_RESTOCK),
        slot: clock.slot,
    });
    Ok(())
}

// ===========================================================================
// close_purchase_request
// ===========================================================================

/// Accounts for [`close_purchase_request`].
///
/// Reclaims rent from a terminal (`Reimbursed` or `Rejected`) request. The
/// `close = caller` constraint drains lamports to the caller, zero-fills the
/// data, and reassigns the account to the system program — preventing revival
/// at the same address with stale data (security checklist: revival attacks).
#[derive(Accounts)]
pub struct ClosePurchaseRequest<'info> {
    pub household: Account<'info, Household>,

    /// Caller's membership — must be active and must be either the household
    /// Owner or the request's recorded buyer (checked in the handler; the
    /// disjunction spans two fields and is clearer in code than in a
    /// constraint).
    #[account(
        seeds = [MEMBER_SEED, household.key().as_ref(), caller.key().as_ref()],
        bump,
        has_one = household,
        constraint = caller_member.active @ StocksieError::MemberInactive,
    )]
    pub caller_member: Account<'info, Member>,

    #[account(
        mut,
        seeds = [
            PURCHASE_SEED,
            household.key().as_ref(),
            request.request_id.to_le_bytes().as_ref(),
        ],
        bump = request.bump,
        has_one = household,
        constraint = request.status.is_terminal() @ StocksieError::InvalidStatusTransition,
        close = caller,
    )]
    pub request: Account<'info, PurchaseRequest>,

    /// Caller. Receives the closed account's rent.
    #[account(mut)]
    pub caller: Signer<'info>,
}

/// Handler for `close_purchase_request()`.
///
/// Authority: the household Owner *or* the request's buyer. Anchor performs
/// the actual close (rent → caller, data wipe, owner reassign) on return; the
/// terminal-status guard is in the accounts constraint.
///
/// Emits nothing — the terminal event (`Reimbursed` or `PurchaseRejected`)
/// was already emitted when the status was reached. Closing is housekeeping;
/// the audit trail lives forever in the event stream.
pub fn close_purchase_request_handler(ctx: Context<ClosePurchaseRequest>) -> Result<()> {
    let is_owner = ctx.accounts.caller_member.role == Role::Owner;
    let is_buyer = ctx.accounts.request.buyer == ctx.accounts.caller.key();
    if !is_owner && !is_buyer {
        return Err(StocksieError::UnauthorizedRole.into());
    }
    // Anchor closes `request` (→ caller) automatically on return.
    Ok(())
}

// ===========================================================================
// Tests
// ===========================================================================

#[cfg(test)]
mod tests {
    use super::*;

    /// The `reason_hash` helper is the only new pure logic in this module — it
    /// must be deterministic, non-zero, and distinct across reasons (so the UI
    /// can map hashes back to badge descriptions unambiguously).
    #[test]
    fn reason_hash_is_deterministic_nonzero_and_distinct() {
        let low_a = hash_reason(REASON_LOW_STOCK);
        let low_b = hash_reason(REASON_LOW_STOCK);
        assert_eq!(low_a, low_b, "blake3 must be deterministic");
        assert_ne!(low_a, [0u8; 32], "reason hash must not be all-zero");

        let restock = hash_reason(REASON_RESTOCK);
        assert_ne!(low_a, restock, "distinct reasons must hash distinctly");
        assert_ne!(restock, [0u8; 32]);
    }

    /// Lock the Feature 2.5 reward schedule so an accidental edit to
    /// `constants.rs` is caught here rather than only in the LiteSVM suite.
    #[test]
    fn auto_reward_constants_match_schedule() {
        assert_eq!(REWARD_LOW_STOCK_REPORT, 10);
        assert_eq!(REWARD_RESTOCK_COMPLETED, 25);
    }

    /// Authority predicates that aren't already covered in `types.rs` — the
    /// close path admits Owner-or-buyer, which this documents at the role
    /// level (the buyer equality is exercised by the integration suite).
    #[test]
    fn close_authority_is_owner_or_buyer_role_predicate() {
        // Owner may always close; non-owners may close only if they are the
        // buyer (an equality check, not a role predicate — asserted in tests/).
        assert!(Role::Owner.can_manage_members()); // Owner has every authority
        assert!(!Role::Child.can_approve());
        assert!(!Role::Guest.can_transact());
    }
}
