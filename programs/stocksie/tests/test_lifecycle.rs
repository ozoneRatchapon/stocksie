//! Phase 8 — purchase-lifecycle integration tests (LiteSVM).
//!
//! Walks a `PurchaseRequest` through its full lifecycle
//! (`Pending → Approved → Restocked → Reimbursed`) with real PDAs, real
//! vault SOL transfers, and balance reconciliation. The alternative
//! terminal path (`Pending → Rejected`) is also covered, with balance
//! assertions proving no funds moved.
//!
//! Coverage (`plan/08_testing.md` §3.4):
//!  1. `full_lifecycle_reaches_reimbursed` — happy path with balance
//!     assertions on vault and buyer, state assertions on every account,
//!     and reward-reconciliation across the audit triangle
//!     (member / request / household).
//!  2. `partial_reimbursement_leaves_residual_ceiling` — paying out less
//!     than the approved amount is allowed; the unused ceiling is not
//!     tracked on-chain (the request is terminal regardless).
//!  3. `rejection_path_moves_no_funds` — `Pending → Rejected` is terminal
//!     and touches no lamports.

#![cfg(not(target_os = "solana"))]

mod helpers;

// Constants and multi-step scenario helpers (`setup_two_member_household`,
// `reach_restocked`, `reach_reimbursed`, `add_member`) live in the shared
// harness so every Phase 8 test file composes the same building blocks (DRY).
use helpers::{
    account_of, balance_of, build_ix, derive_request, emitted_events_of, reach_restocked, send,
    setup_svm, setup_two_member_household, DEPOSIT_LAMPORTS, ITEM_HASH, REIMBURSE_LAMPORTS,
    REQUEST_AMOUNT_LAMPORTS, SYSTEM_PROGRAM_ID, TOTAL_LIFECYCLE_REWARD, UNIT_COST_HASH,
};
use solana_signer::Signer;
use stocksie::events::{Reimbursed, RewardEarned};
use stocksie::state::{Household, Member, PurchaseRequest};
use stocksie::types::Status;

// ===========================================================================
// Test 1 — full_lifecycle_reaches_reimbursed
// ===========================================================================

/// The full happy path: `Pending → Approved → Restocked → Reimbursed`,
/// with hard balance assertions on vault and buyer, state assertions on
/// every account, the audit-triangle reward reconciliation (member /
/// request / household accumulators all agreeing), and event assertions
/// on the final `Reimbursed` + `RewardEarned` pair.
#[test]
fn full_lifecycle_reaches_reimbursed() {
    let (mut svm, owner) = setup_svm();
    let (parent, household_pda, owner_member_pda, parent_member_pda) =
        setup_two_member_household(&mut svm, &owner);

    // --- Drive to Restocked ---
    let request_pda = reach_restocked(
        &mut svm,
        &owner,
        &parent,
        household_pda,
        owner_member_pda,
        parent_member_pda,
    );

    // Capture balances *immediately before* the reimbursement tx so the
    // delta assertions are robust to whatever rent/fees accrued earlier
    // in the lifecycle.
    let vault_lamports_before = balance_of(&svm, &household_pda);
    let buyer_lamports_before = balance_of(&svm, &parent.pubkey());

    // --- Act: reimburse_buyer by the owner (approver). ---
    let reimburse_ix = build_ix(
        &stocksie::accounts::ReimburseBuyer {
            household: household_pda,
            caller_member: owner_member_pda,
            request: request_pda,
            buyer_member: parent_member_pda,
            buyer: parent.pubkey(),
            caller: owner.pubkey(),
        },
        &stocksie::instruction::ReimburseBuyer {
            lamports: REIMBURSE_LAMPORTS,
        },
    );
    let reimburse_result = send(&mut svm, &owner, reimburse_ix);
    assert!(
        reimburse_result.is_ok(),
        "reimburse_buyer failed:\n{}",
        reimburse_result.as_ref().unwrap_err().meta.pretty_logs()
    );

    // --- Assert: vault debited exactly REIMBURSE_LAMPORTS. ---
    let vault_lamports_after = balance_of(&svm, &household_pda);
    assert_eq!(
        vault_lamports_after,
        vault_lamports_before - REIMBURSE_LAMPORTS,
        "vault should be debited by exactly the reimbursement amount"
    );

    // --- Assert: buyer credited exactly REIMBURSE_LAMPORTS. ---
    // The buyer is not the tx payer (the owner/approver is), so no fee
    // is deducted from the buyer — the credit is the full amount.
    let buyer_lamports_after = balance_of(&svm, &parent.pubkey());
    assert_eq!(
        buyer_lamports_after,
        buyer_lamports_before + REIMBURSE_LAMPORTS,
        "buyer should be credited the full reimbursement amount"
    );

    // --- Assert: request is terminal (Reimbursed). ---
    let request: PurchaseRequest =
        account_of(&svm, &request_pda).expect("request PDA must still exist");
    assert_eq!(request.status, Status::Reimbursed);
    assert!(request.status.is_terminal());
    assert_eq!(
        request.reimbursed_amount, REIMBURSE_LAMPORTS,
        "reimbursed_amount must record the actual payout"
    );
    assert_eq!(
        request.reward_earned, TOTAL_LIFECYCLE_REWARD,
        "request.reward_earned must equal the sum of all three reward stages"
    );

    // --- Assert: household vault_balance mirror matches the actual lamports delta. ---
    let household: Household =
        account_of(&svm, &household_pda).expect("household PDA must still exist");
    assert_eq!(
        household.vault_balance,
        DEPOSIT_LAMPORTS - REIMBURSE_LAMPORTS,
        "household.vault_balance mirror must match (deposit − reimbursement)"
    );
    assert_eq!(
        household.request_counter, 1,
        "request_counter must be 1 after one create"
    );
    assert_eq!(
        household.total_rewards_distributed, TOTAL_LIFECYCLE_REWARD,
        "household.total_rewards_distributed must equal the sum of all three reward stages"
    );

    // --- Assert: audit-triangle reconciliation (member side). ---
    // The owner is the reporter (low-stock reward only).
    // The parent is the buyer (restock + full-run rewards).
    let owner_member: Member =
        account_of(&svm, &owner_member_pda).expect("owner member PDA must still exist");
    assert_eq!(
        owner_member.reward_points,
        stocksie::constants::REWARD_LOW_STOCK_REPORT,
        "owner (reporter) earns only the low-stock reward"
    );
    let parent_member: Member =
        account_of(&svm, &parent_member_pda).expect("parent member PDA must still exist");
    assert_eq!(
        parent_member.reward_points,
        stocksie::constants::REWARD_RESTOCK_COMPLETED
            + stocksie::constants::REWARD_FULL_RUN_COMPLETED,
        "parent (buyer) earns restock + full-run rewards"
    );

    // --- Assert: Reimbursed + RewardEarned events were emitted by this tx. ---
    let reimbursed_events: Vec<Reimbursed> = emitted_events_of(&reimburse_result);
    assert_eq!(
        reimbursed_events.len(),
        1,
        "reimburse_buyer should emit exactly one Reimbursed event"
    );
    assert_eq!(reimbursed_events[0].request, request_pda);
    assert_eq!(reimbursed_events[0].buyer, parent.pubkey());
    assert_eq!(reimbursed_events[0].lamports, REIMBURSE_LAMPORTS);
    assert_eq!(reimbursed_events[0].status, Status::Reimbursed);

    let reward_events: Vec<RewardEarned> = emitted_events_of(&reimburse_result);
    assert_eq!(
        reward_events.len(),
        1,
        "reimburse_buyer should emit exactly one RewardEarned event (full-run)"
    );
    assert_eq!(reward_events[0].member, parent.pubkey());
    assert_eq!(
        reward_events[0].points,
        stocksie::constants::REWARD_FULL_RUN_COMPLETED
    );
    assert_eq!(
        reward_events[0].total_points, parent_member.reward_points,
        "total_points in the event must match the post-credit member balance"
    );
}

// ===========================================================================
// Test 2 — partial_reimbursement_leaves_residual_ceiling
// ===========================================================================

/// Paying out strictly less than `amount_lamports` is allowed; the
/// request becomes terminal Reimbursed regardless. The unused ceiling
/// is not tracked on-chain (no partial-residual field); the audit
/// trail records `reimbursed_amount` as the actual payout, which is
/// strictly less than `amount_lamports`.
#[test]
fn partial_reimbursement_leaves_residual_ceiling() {
    let (mut svm, owner) = setup_svm();
    let (parent, household_pda, owner_member_pda, parent_member_pda) =
        setup_two_member_household(&mut svm, &owner);
    let request_pda = reach_restocked(
        &mut svm,
        &owner,
        &parent,
        household_pda,
        owner_member_pda,
        parent_member_pda,
    );

    // Pay out a tiny fraction of the approved ceiling.
    let tiny_reimburse = stocksie::constants::MIN_REQUEST_LAMPORTS; // 0.0001 SOL
    let reimburse_ix = build_ix(
        &stocksie::accounts::ReimburseBuyer {
            household: household_pda,
            caller_member: owner_member_pda,
            request: request_pda,
            buyer_member: parent_member_pda,
            buyer: parent.pubkey(),
            caller: owner.pubkey(),
        },
        &stocksie::instruction::ReimburseBuyer {
            lamports: tiny_reimburse,
        },
    );
    let reimburse_result = send(&mut svm, &owner, reimburse_ix);
    assert!(
        reimburse_result.is_ok(),
        "partial reimbursement should succeed:\n{}",
        reimburse_result.as_ref().unwrap_err().meta.pretty_logs()
    );

    let request: PurchaseRequest =
        account_of(&svm, &request_pda).expect("request PDA must still exist");
    assert_eq!(request.status, Status::Reimbursed);
    assert!(request.status.is_terminal());
    assert_eq!(
        request.reimbursed_amount, tiny_reimburse,
        "reimbursed_amount must record the actual payout, not the ceiling"
    );
    assert!(
        request.reimbursed_amount < request.amount_lamports,
        "the partial-reimbursement branch must leave a positive residual ceiling"
    );
}

// ===========================================================================
// Test 3 — rejection_path_moves_no_funds
// ===========================================================================

/// The `Pending → Rejected` terminal path must move no lamports: the
/// vault balance is unchanged, the buyer balance is unchanged, and the
/// reporter's low-stock reward *persists* (reporting the problem is
/// rewarded regardless of the outcome — see `05_state_machine.md` §3
/// `Rejected` invariants).
#[test]
fn rejection_path_moves_no_funds() {
    let (mut svm, owner) = setup_svm();
    let (parent, household_pda, owner_member_pda, parent_member_pda) =
        setup_two_member_household(&mut svm, &owner);
    let owner_pk = owner.pubkey();
    let parent_pk = parent.pubkey();

    // --- Establish: a request exists in Pending. ---
    let (request_pda, _) = derive_request(&household_pda, 1);
    let create_ix = build_ix(
        &stocksie::accounts::CreatePurchaseRequest {
            household: household_pda,
            caller_member: owner_member_pda,
            request: request_pda,
            buyer_member: parent_member_pda,
            caller: owner_pk,
            system_program: SYSTEM_PROGRAM_ID,
        },
        &stocksie::instruction::CreatePurchaseRequest {
            amount_lamports: REQUEST_AMOUNT_LAMPORTS,
            item_hash: ITEM_HASH,
            unit_cost_hash: UNIT_COST_HASH,
            buyer: parent_pk,
        },
    );
    assert!(
        send(&mut svm, &owner, create_ix).is_ok(),
        "create precondition failed"
    );

    // Capture every relevant balance *after* the create (which funded
    // the reporter's low-stock reward in points — not in lamports) so
    // the rejection's "no funds moved" assertion is unambiguous.
    let vault_before = balance_of(&svm, &household_pda);
    let buyer_before = balance_of(&svm, &parent_pk);

    // --- Act: reject the pending request. ---
    let reason_hash = [0u8; 32]; // "no reason given" sentinel
    let reject_ix = build_ix(
        &stocksie::accounts::RejectPurchaseRequest {
            household: household_pda,
            caller_member: owner_member_pda,
            request: request_pda,
            caller: owner_pk,
        },
        &stocksie::instruction::RejectPurchaseRequest { reason_hash },
    );
    let reject_result = send(&mut svm, &owner, reject_ix);
    assert!(
        reject_result.is_ok(),
        "reject_purchase_request failed:\n{}",
        reject_result.as_ref().unwrap_err().meta.pretty_logs()
    );

    // --- Assert: no lamports moved. ---
    assert_eq!(
        balance_of(&svm, &household_pda),
        vault_before,
        "rejection must not debit the vault"
    );
    assert_eq!(
        balance_of(&svm, &parent_pk),
        buyer_before,
        "rejection must not credit the buyer"
    );

    // --- Assert: request is terminal Rejected, with no reimbursement. ---
    let request: PurchaseRequest =
        account_of(&svm, &request_pda).expect("request PDA must still exist");
    assert_eq!(request.status, Status::Rejected);
    assert!(request.status.is_terminal());
    assert_eq!(
        request.reimbursed_amount, 0,
        "no funds ever moved on the rejection path"
    );

    // --- Assert: reporter's low-stock reward persists
    //   (per `05_state_machine.md` §3 `Rejected` invariants).
    assert!(
        request.reward_earned >= stocksie::constants::REWARD_LOW_STOCK_REPORT,
        "the reporter's low-stock reward must persist even on rejection"
    );
}
