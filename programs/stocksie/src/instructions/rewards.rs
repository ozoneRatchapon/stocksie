//! Reward instructions — manual point grants and read-only score emits.
//!
//! Covers Feature 2.5 (gamification) audit-stream operations:
//!   - [`award_reward`]   : Owner/Parent manually grants points to any active
//!     member for any reason (e.g. "noticed the milk was expiring", "found a
//!     coupon"). The reason text is hashed *off-chain by the client* and passed
//!     in as `reason_hash`; the program never sees the plaintext.
//!   - [`reward_summary`] : read-only convenience emit so a client can fetch a
//!     member's current cumulative score from the event stream without
//!     deserializing the `Member` account.
//!
//! Authority model: `award_reward` is gated to active Owner/Parent via
//! `caller_member.can_award_rewards()`; `reward_summary` is open to any active
//! member (any role — Guests included, since it emits nothing but a score
//! fetch). Both load the caller's `Member` PDA (seeds + `has_one`) so the auth
//! root is the seed, not a stored list.
//!
//! Privacy (Feature 3.5): `award_reward` takes a caller-supplied
//! `reason_hash: [u8; 32]` — the human-readable reason lives off-chain and is
//! blake3-hashed by the client before submission. The program passes it through
//! to the event verbatim (it cannot verify "is this a real blake3 hash?" — any
//! 32 bytes are syntactically valid). `reward_summary` emits the literal
//! [`SUMMARY_SENTINEL`] so auditors can distinguish a score-fetch from a real
//! grant: `Member::add_reward` rejects `points = 0`, and the all-zero hash is
//! never produced by a real credit path, so the distinguisher is unambiguous.

use crate::constants::MEMBER_SEED;
use crate::error::StocksieError;
use crate::events::RewardEarned;
use crate::state::{Household, Member};
use anchor_lang::prelude::*;

/// The all-zero `reason_hash` sentinel emitted by [`reward_summary_handler`].
///
/// Lets auditors distinguish a score-fetch emit from a real reward grant:
///   - `Member::add_reward` rejects `points = 0`, so the `points = 0` half of
///     the sentinel can never come from a real credit.
///   - blake3 of any non-empty input is nonzero with overwhelming probability,
///     so this all-zero hash can never collide with a real `reason_hash`.
///
/// Together these make a `reward_summary` emit unambiguously identifiable in
/// the audit stream.
const SUMMARY_SENTINEL: [u8; 32] = [0u8; 32];

// ===========================================================================
// award_reward
// ===========================================================================

/// Accounts for [`award_reward`].
///
/// `target_member` is seeded by the instruction arg `member_wallet` (NOT the
/// caller), so the caller may target any active member of the household — not
/// just themselves. The seed derivation proves the target is a real member PDA
/// of *this* household; `has_one` re-checks the back-reference; the explicit
/// `wallet == member_wallet` constraint is defense-in-depth against data
/// corruption (the seed already derives the correct address, so a mismatch here
/// indicates tampered account data); `active` blocks rewarding a soft-deleted
/// member.
#[derive(Accounts)]
#[instruction(member_wallet: Pubkey, points: u64, reason_hash: [u8; 32])]
pub struct AwardReward<'info> {
    /// Household + vault PDA. Mutated: `total_rewards_distributed` accumulates
    /// the granted points via `record_rewards` (the audit-triangle household
    /// accumulator).
    #[account(mut)]
    pub household: Account<'info, Household>,

    /// Caller's membership — the reward gate. Seeds bind it to `household` +
    /// `caller`; `has_one` re-verifies the back-reference; `active` blocks
    /// deactivated members; `can_award_rewards()` admits Owner/Parent only.
    #[account(
        seeds = [MEMBER_SEED, household.key().as_ref(), caller.key().as_ref()],
        bump,
        has_one = household,
        constraint = caller_member.active @ StocksieError::MemberInactive,
        constraint = caller_member.role.can_award_rewards() @ StocksieError::UnauthorizedRole,
    )]
    pub caller_member: Account<'info, Member>,

    /// The member being rewarded — `mut` because `reward_points` increments.
    /// Seeded by the instruction arg `member_wallet` (so the caller may target
    /// any member, not just themselves). `has_one` binds it to this household
    /// (cross-cutting rule #4); `wallet == member_wallet` is defense-in-depth
    /// (the seed derives the address, this guards stored-field integrity);
    /// `active` blocks rewarding a deactivated member.
    #[account(
        mut,
        seeds = [MEMBER_SEED, household.key().as_ref(), member_wallet.as_ref()],
        bump,
        has_one = household,
        constraint = target_member.active @ StocksieError::MemberInactive,
        constraint = target_member.wallet == member_wallet @ StocksieError::MemberNotFound,
    )]
    pub target_member: Account<'info, Member>,

    /// The authorizing reward authority (Owner/Parent).
    pub caller: Signer<'info>,
}

/// Handler for `award_reward(member_wallet, points, reason_hash)`.
///
/// Business rules enforced here (not expressible as constraints):
///   - `points` must be `> 0`. [`Member::add_reward`] re-checks this
///     (`ZeroReward`), but failing early keeps the error unambiguous before any
///     account mutation.
///   - The reward accumulators move via the state-layer guards:
///     [`Member::add_reward`] (checked `reward_points += points`) and
///     [`Household::record_rewards`] (checked `total_rewards_distributed +=
///     points`). Both surface `RewardOverflow` on u64 wrap; Solana's
///     transaction atomicity rolls back the member credit if the household
///     accumulator then overflows (and vice versa).
///
/// `reason_hash` is a caller-supplied blake3 digest of the off-chain
/// human-readable reason; the program passes it through to the event verbatim.
/// Manual awards are not tied to a purchase, so there is no per-request
/// accumulator to update (unlike the auto-reward paths in `purchase` /
/// `reimburse`, which form a three-way audit triangle).
///
/// Emits [`RewardEarned`] with the post-credit `total_points` snapshot.
pub fn award_reward_handler(
    ctx: Context<AwardReward>,
    member_wallet: Pubkey,
    points: u64,
    reason_hash: [u8; 32],
) -> Result<()> {
    // Fail fast on zero so the error is unambiguous before any mutation. The
    // state-layer guard re-checks this, but the early return keeps the call
    // ordering robust: a future reorder cannot leave a partial accumulator
    // update behind a ZeroReward.
    if points == 0 {
        return Err(StocksieError::ZeroReward.into());
    }

    // Capture immutable snapshots before any mutable borrows (mirrors the
    // pattern in `create_purchase_request_handler` / `reimburse_buyer_handler`
    // so the `emit!` never aliases a live `&mut self` borrow).
    let household_key = ctx.accounts.household.key();
    let clock = Clock::get()?;

    // Audit pair: member + household accumulators move together. (No
    // per-request accumulator — manual awards are not purchase-tied.)
    ctx.accounts.target_member.add_reward(points)?;
    ctx.accounts.household.record_rewards(points)?;

    emit!(RewardEarned {
        household: household_key,
        member: member_wallet,
        points,
        total_points: ctx.accounts.target_member.reward_points,
        reason_hash,
        slot: clock.slot,
    });
    Ok(())
}

// ===========================================================================
// reward_summary
// ===========================================================================

/// Accounts for [`reward_summary`].
///
/// Read-only score emit. `household` is a reference (no mutation — there is
/// nothing to record); `caller_member` is loaded to prove the caller is an
/// active member of this household (any role — Guests included, since this
/// emits nothing but a score fetch and touches no state).
#[derive(Accounts)]
pub struct RewardSummary<'info> {
    /// Household reference. Read-only — no state mutates.
    pub household: Account<'info, Household>,

    /// Caller's membership — proves active membership (any role). Seeds bind it
    /// to `household` + `caller`; `has_one` re-verifies the back-reference;
    /// `active` blocks deactivated members from spamming the audit stream.
    #[account(
        seeds = [MEMBER_SEED, household.key().as_ref(), caller.key().as_ref()],
        bump,
        has_one = household,
        constraint = caller_member.active @ StocksieError::MemberInactive,
    )]
    pub caller_member: Account<'info, Member>,

    /// The member whose score is being fetched.
    pub caller: Signer<'info>,
}

/// Handler for `reward_summary()`.
///
/// Read-only: no state mutation. Emits [`RewardEarned`] with the sentinel
/// `points = 0` and `reason_hash =` [`SUMMARY_SENTINEL`] so auditors can
/// distinguish a score-fetch from a real reward grant. The `total_points`
/// field carries the member's current cumulative score.
///
/// Distinguishability is unambiguous: `Member::add_reward` rejects `points = 0`
/// (so the `points = 0` half can never come from a real credit), and the
/// all-zero hash is never produced by blake3 of any real reason string (so the
/// `reason_hash` half can't collide either). Either field alone suffices to
/// tag the emit as a summary; both together make it self-evident.
pub fn reward_summary_handler(ctx: Context<RewardSummary>) -> Result<()> {
    let household_key = ctx.accounts.household.key();
    let caller_key = ctx.accounts.caller.key();
    let clock = Clock::get()?;

    emit!(RewardEarned {
        household: household_key,
        member: caller_key,
        points: 0,
        total_points: ctx.accounts.caller_member.reward_points,
        reason_hash: SUMMARY_SENTINEL,
        slot: clock.slot,
    });
    Ok(())
}

// ===========================================================================
// Tests
// ===========================================================================

#[cfg(test)]
mod tests {
    use crate::types::Role;

    /// The manual-award authority gate is `can_award_rewards()` (Owner/Parent)
    /// — the same predicate encoded in the `caller_member` constraint. Asserting
    /// it here keeps the instruction-level policy honest against future `Role`
    /// edits (mirrors the gate tests in `funds.rs` / `reimburse.rs`).
    #[test]
    fn award_authority_is_reward_gate() {
        assert!(Role::Owner.can_award_rewards());
        assert!(Role::Parent.can_award_rewards());
        assert!(!Role::Child.can_award_rewards());
        assert!(!Role::Guest.can_award_rewards());
    }

    /// In the MVP, the reward authority (`can_award_rewards`) and the approve
    /// authority (`can_approve`) are the *same* role set (Owner/Parent). Pinning
    /// this prevents accidental divergence: if a future change grants award
    /// rights to a role that cannot approve (or vice versa), this test surfaces
    /// the policy shift explicitly so it gets reviewed rather than slipping in.
    #[test]
    fn reward_authority_matches_approve_authority_in_mvp() {
        for role in [Role::Owner, Role::Parent, Role::Child, Role::Guest] {
            assert_eq!(
                role.can_award_rewards(),
                role.can_approve(),
                "reward and approve authority diverged for {:?}",
                role,
            );
        }
    }
}
