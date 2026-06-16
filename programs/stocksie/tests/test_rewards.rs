//! Phase 8 — reward-flow tests (LiteSVM).
//!
//! Covers the manual-award and read-only summary paths in
//! `instructions/rewards.rs`:
//!   - `award_reward_to_member`  — happy path with audit-triangle
//!     reconciliation (member + household accumulators) and the `RewardEarned`
//!     event field contract.
//!   - `reward_summary_emits_sentinel` — `points == 0` and
//!     `reason_hash == [0; 32]` distinguish a score-fetch emit from a real
//!     grant (no state mutates).
//!   - `award_reward_zero_rejected`  → `ZeroReward`
//!   - `award_reward_overflow`       → `RewardOverflow` (two awards summing
//!     past `u64::MAX`; `Member::add_reward`'s checked arithmetic fires).
//!
//! The role-gate rejection for `award_reward` (`UnauthorizedRole` when a
//! Child/Guest calls it) lives in `test_permissions.rs::child_cannot_award_reward`,
//! alongside the other role-gate negative tests.

#![cfg(not(target_os = "solana"))]

mod helpers;

// Shared fixtures and the multi-step scenario helpers
// (`setup_two_member_household`) live in the harness so every Phase 8 file
// composes the same building blocks (DRY).
use helpers::{
    account_of, assert_error_code, build_ix, emitted_events_of, send, setup_svm,
    setup_two_member_household,
};
use solana_signer::Signer;
use stocksie::error::StocksieError;
use stocksie::events::RewardEarned;
use stocksie::state::{Household, Member};

// ===========================================================================
// Test 1 — award_reward_to_member (happy path + reconciliation)
// ===========================================================================

/// The Owner (a valid reward authority via `can_award_rewards()`) grants
/// `points` to the Parent (an active member). The audit pair —
/// `Member::reward_points` and `Household::total_rewards_distributed` — must
/// move together, and a single `RewardEarned` event must be emitted carrying
/// the post-credit `total_points` snapshot and the verbatim `reason_hash`.
#[test]
fn award_reward_to_member() {
    let (mut svm, owner) = setup_svm();
    let (_parent, household_pda, owner_member_pda, parent_member_pda) =
        setup_two_member_household(&mut svm, &owner);

    // Capture the pre-award totals so the deltas are unambiguous.
    let parent_before: Member =
        account_of(&svm, &parent_member_pda).expect("parent member must exist");
    let household_before: Household =
        account_of(&svm, &household_pda).expect("household must exist");

    let points: u64 = 7;
    let reason_hash = [0x77u8; 32];

    let award_ix = build_ix(
        &stocksie::accounts::AwardReward {
            household: household_pda,
            caller_member: owner_member_pda,
            target_member: parent_member_pda,
            caller: owner.pubkey(),
        },
        &stocksie::instruction::AwardReward {
            member_wallet: _parent.pubkey(),
            points,
            reason_hash,
        },
    );
    let result = send(&mut svm, &owner, award_ix);
    assert!(
        result.is_ok(),
        "award_reward failed:\n{}",
        result.as_ref().unwrap_err().meta.pretty_logs()
    );

    // --- Assert: audit-pair reconciliation (member + household). ---
    let parent_after: Member =
        account_of(&svm, &parent_member_pda).expect("parent member must still exist");
    let household_after: Household =
        account_of(&svm, &household_pda).expect("household must still exist");
    assert_eq!(
        parent_after.reward_points,
        parent_before.reward_points + points,
        "member accumulator must increase by exactly `points`"
    );
    assert_eq!(
        household_after.total_rewards_distributed,
        household_before.total_rewards_distributed + points,
        "household accumulator must increase by exactly `points`"
    );

    // --- Assert: exactly one RewardEarned event with the field contract. ---
    let events: Vec<RewardEarned> = emitted_events_of(&result);
    assert_eq!(
        events.len(),
        1,
        "award_reward should emit exactly one RewardEarned"
    );
    assert_eq!(events[0].household, household_pda);
    assert_eq!(events[0].member, _parent.pubkey());
    assert_eq!(events[0].points, points);
    assert_eq!(
        events[0].total_points, parent_after.reward_points,
        "total_points must be the post-credit snapshot"
    );
    assert_eq!(
        events[0].reason_hash, reason_hash,
        "reason_hash is passed through verbatim"
    );
}

// ===========================================================================
// Test 2 — reward_summary_emits_sentinel
// ===========================================================================

/// `reward_summary` is a read-only score-fetch: it mutates no state and emits
/// a `RewardEarned` with the sentinel `points == 0` and
/// `reason_hash == [0u8; 32]` so auditors can unambiguously distinguish it
/// from a real grant. The `total_points` field carries the caller's current
/// cumulative score.
#[test]
fn reward_summary_emits_sentinel() {
    let (mut svm, owner) = setup_svm();
    let (_parent, household_pda, owner_member_pda, _parent_member_pda) =
        setup_two_member_household(&mut svm, &owner);

    // Snapshot pre-state so the "no mutation" assertion is concrete.
    let household_before: Household =
        account_of(&svm, &household_pda).expect("household must exist");
    let owner_member_before: Member =
        account_of(&svm, &owner_member_pda).expect("owner member must exist");

    let summary_ix = build_ix(
        &stocksie::accounts::RewardSummary {
            household: household_pda,
            caller_member: owner_member_pda,
            caller: owner.pubkey(),
        },
        &stocksie::instruction::RewardSummary {},
    );
    let result = send(&mut svm, &owner, summary_ix);
    assert!(
        result.is_ok(),
        "reward_summary failed:\n{}",
        result.as_ref().unwrap_err().meta.pretty_logs()
    );

    // --- Assert: no state mutated. ---
    let household_after: Household =
        account_of(&svm, &household_pda).expect("household must still exist");
    let owner_member_after: Member =
        account_of(&svm, &owner_member_pda).expect("owner member must still exist");
    assert_eq!(
        household_after.total_rewards_distributed, household_before.total_rewards_distributed,
        "reward_summary must not move household accumulators"
    );
    assert_eq!(
        owner_member_after.reward_points, owner_member_before.reward_points,
        "reward_summary must not move member accumulators"
    );

    // --- Assert: exactly one RewardEarned with the sentinel pair. ---
    let events: Vec<RewardEarned> = emitted_events_of(&result);
    assert_eq!(
        events.len(),
        1,
        "reward_summary should emit exactly one RewardEarned"
    );
    assert_eq!(events[0].household, household_pda);
    assert_eq!(events[0].member, owner.pubkey());
    assert_eq!(
        events[0].points, 0,
        "sentinel: a score-fetch emits `points == 0` (real grants are > 0)"
    );
    assert_eq!(
        events[0].reason_hash, [0u8; 32],
        "sentinel: a score-fetch emits the all-zero `reason_hash`"
    );
    assert_eq!(
        events[0].total_points, owner_member_after.reward_points,
        "total_points must carry the caller's current cumulative score"
    );
}

// ===========================================================================
// Test 3 — award_reward_zero_rejected
// ===========================================================================

/// `award_reward` rejects `points == 0` (`ZeroReward`). The handler fails fast
/// before any accumulator mutation; `Member::add_reward` would re-check this
/// anyway, but the early return keeps the call ordering robust against future
/// refactors.
#[test]
fn award_reward_zero_rejected() {
    let (mut svm, owner) = setup_svm();
    let (parent, household_pda, owner_member_pda, parent_member_pda) =
        setup_two_member_household(&mut svm, &owner);

    let award_ix = build_ix(
        &stocksie::accounts::AwardReward {
            household: household_pda,
            caller_member: owner_member_pda,
            target_member: parent_member_pda,
            caller: owner.pubkey(),
        },
        &stocksie::instruction::AwardReward {
            member_wallet: parent.pubkey(),
            points: 0,
            reason_hash: [0x33u8; 32],
        },
    );
    let result = send(&mut svm, &owner, award_ix);
    assert!(result.is_err(), "zero-point award should have failed");
    assert_error_code(result.unwrap_err(), StocksieError::ZeroReward);
}

// ===========================================================================
// Test 4 — award_reward_overflow
// ===========================================================================

/// Two awards whose sum exceeds `u64::MAX` must trigger `RewardOverflow` from
/// `Member::add_reward`'s checked arithmetic. The first award brings the
/// member's `reward_points` close to the `u64` ceiling; the second award
/// (small, but enough to wrap) is what fails. The household accumulator is
/// sized to still have headroom after the first award, so the *member*-side
/// check fires first inside `award_reward_handler` and is the one asserted.
///
/// Solana's transaction atomicity guarantees the member's `reward_points` is
/// not advanced past `u64::MAX`: the failed `add_reward` reverts the whole tx.
#[test]
fn award_reward_overflow() {
    let (mut svm, owner) = setup_svm();
    let (parent, household_pda, owner_member_pda, parent_member_pda) =
        setup_two_member_household(&mut svm, &owner);

    // 1. First award: bring the member near the ceiling with a large single
    //    grant. `u64::MAX - 10` is itself representable, and the household
    //    accumulator (starting at the lifecycle setup value) still has ample
    //    headroom, so this call succeeds.
    let near_max = u64::MAX - 10;
    let first_ix = build_ix(
        &stocksie::accounts::AwardReward {
            household: household_pda,
            caller_member: owner_member_pda,
            target_member: parent_member_pda,
            caller: owner.pubkey(),
        },
        &stocksie::instruction::AwardReward {
            member_wallet: parent.pubkey(),
            points: near_max,
            reason_hash: [0x55u8; 32],
        },
    );
    let first = send(&mut svm, &owner, first_ix);
    assert!(
        first.is_ok(),
        "near-overflow precondition award failed:\n{}",
        first.as_ref().unwrap_err().meta.pretty_logs()
    );

    // 2. Second award: 11 points. `near_max + 11` wraps `u64`, so
    //    `Member::add_reward` returns `RewardOverflow`. The handler's `?`
    //    propagates it before `Household::record_rewards` runs.
    let overflow_ix = build_ix(
        &stocksie::accounts::AwardReward {
            household: household_pda,
            caller_member: owner_member_pda,
            target_member: parent_member_pda,
            caller: owner.pubkey(),
        },
        &stocksie::instruction::AwardReward {
            member_wallet: parent.pubkey(),
            points: 11,
            reason_hash: [0x66u8; 32],
        },
    );
    let result = send(&mut svm, &owner, overflow_ix);
    assert!(result.is_err(), "overflowing award should have failed");
    assert_error_code(result.unwrap_err(), StocksieError::RewardOverflow);

    // --- Assert: the failed award did not advance the member's total. ---
    // Atomicity: `reward_points` stays at the post-first-award value.
    let parent_member: Member =
        account_of(&svm, &parent_member_pda).expect("parent member must still exist");
    assert_eq!(
        parent_member.reward_points, near_max,
        "the overflowing award must be rolled back — member total unchanged"
    );
}
