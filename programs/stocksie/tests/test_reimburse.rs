//! Phase 8 — `reimburse_buyer` negative-path tests (LiteSVM).
//!
//! Owns the reimburse-specific half of the `05_state_machine.md` §4
//! forbidden-transition matrix plus the value-guard arms of
//! `PurchaseRequest::transition_reimbursed` and the vault-solvency check in
//! `Household::debit_vault`. Each test isolates exactly one failing guard so
//! the asserted `StocksieError` code unambiguously identifies the branch.
//!
//! The non-reimburse forbidden transitions (`confirm_restock` from `Pending`,
//! `reject`/`approve` from disallowed states) live in `test_permissions.rs`;
//! together the two files cover all twelve entries of the matrix.
//!
//! Coverage map (`plan/08_testing.md`):
//!   - `reimburse_from_pending_rejected`   → `InvalidStatusTransition`
//!   - `reimburse_from_approved_rejected`  → `InvalidStatusTransition`
//!   - `reimburse_from_rejected_rejected`  → `InvalidStatusTransition`
//!   - `reimburse_over_ceiling`            → `ReimbursementExceedsApproved`
//!   - `reimburse_zero`                    → `ZeroWithdrawal`
//!   - `double_reimburse`                  → `AlreadyReimbursed`
//!   - `reimburse_insufficient_vault`      → `InsufficientVaultFunds`
//!
//! Order-of-checks invariant relied on here: `reimburse_buyer_handler` runs
//! `transition_reimbursed` *before* `debit_vault`, so the status / ceiling /
//! zero guards fire before any SOL movement, and Solana's transaction
//! atomicity rolls back the (failed) SOL move on `InsufficientVaultFunds`.

#![cfg(not(target_os = "solana"))]

mod helpers;

// Shared fixtures and the multi-step scenario helpers
// (`setup_two_member_household`, `reach_restocked`, `reach_reimbursed`) live
// in the harness so every Phase 8 file composes the same building blocks (DRY).
use helpers::{
    assert_error_code, build_ix, derive_request, reach_restocked, send, setup_svm,
    setup_two_member_household, Keypair, Pubkey, DEPOSIT_LAMPORTS, ITEM_HASH, REIMBURSE_LAMPORTS,
    REQUEST_AMOUNT_LAMPORTS, SYSTEM_PROGRAM_ID, UNIT_COST_HASH,
};
use solana_signer::Signer;
use stocksie::error::StocksieError;

// ===========================================================================
// Local scenario helpers
// ===========================================================================

/// Create a `PurchaseRequest` in the `Pending` state and return its PDA.
///
/// `reporter` signs (and pays rent); `buyer` is the designated shopper (must
/// be an active transacting member). The `request_id` is always `1` here
/// because every test starts from a fresh SVM with `request_counter = 0`.
fn create_request(
    svm: &mut litesvm::LiteSVM,
    reporter: &Keypair,
    reporter_member_pda: Pubkey,
    buyer: Pubkey,
    buyer_member_pda: Pubkey,
    household_pda: Pubkey,
) -> Pubkey {
    let (request_pda, _) = derive_request(&household_pda, 1);
    let ix = build_ix(
        &stocksie::accounts::CreatePurchaseRequest {
            household: household_pda,
            caller_member: reporter_member_pda,
            request: request_pda,
            buyer_member: buyer_member_pda,
            caller: reporter.pubkey(),
            system_program: SYSTEM_PROGRAM_ID,
        },
        &stocksie::instruction::CreatePurchaseRequest {
            amount_lamports: REQUEST_AMOUNT_LAMPORTS,
            item_hash: ITEM_HASH,
            unit_cost_hash: UNIT_COST_HASH,
            buyer,
        },
    );
    let result = send(svm, reporter, ix);
    assert!(
        result.is_ok(),
        "create_request precondition failed:\n{}",
        result.as_ref().unwrap_err().meta.pretty_logs()
    );
    request_pda
}

// ===========================================================================
// Status-guard tests — `transition_reimbursed` rejects non-`Restocked` states
// ===========================================================================

/// `reimburse_buyer` from `Pending` (request not yet approved or restocked) →
/// `InvalidStatusTransition`. The status guard fires before the ceiling/zero
/// checks, so the lamports value passed is irrelevant (any in-range value
/// would do — `REIMBURSE_LAMPORTS` is used purely to keep the call realistic).
#[test]
fn reimburse_from_pending_rejected() {
    let (mut svm, owner) = setup_svm();
    let (parent, household_pda, owner_member_pda, parent_member_pda) =
        setup_two_member_household(&mut svm, &owner);

    let request_pda = create_request(
        &mut svm,
        &owner,
        owner_member_pda,
        parent.pubkey(),
        parent_member_pda,
        household_pda,
    );

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
    let result = send(&mut svm, &owner, reimburse_ix);
    assert!(result.is_err(), "reimburse from Pending should have failed");
    assert_error_code(result.unwrap_err(), StocksieError::InvalidStatusTransition);
}

/// `reimburse_buyer` from `Approved` (buyer has not shopped yet) →
/// `InvalidStatusTransition`. Skipping `confirm_restock` is forbidden even
/// though the approver is otherwise a valid caller.
#[test]
fn reimburse_from_approved_rejected() {
    let (mut svm, owner) = setup_svm();
    let (parent, household_pda, owner_member_pda, parent_member_pda) =
        setup_two_member_household(&mut svm, &owner);

    let request_pda = create_request(
        &mut svm,
        &owner,
        owner_member_pda,
        parent.pubkey(),
        parent_member_pda,
        household_pda,
    );

    // Drive Pending → Approved.
    let approve_ix = build_ix(
        &stocksie::accounts::ApprovePurchaseRequest {
            household: household_pda,
            caller_member: owner_member_pda,
            request: request_pda,
            caller: owner.pubkey(),
        },
        &stocksie::instruction::ApprovePurchaseRequest {},
    );
    let approve_result = send(&mut svm, &owner, approve_ix);
    assert!(approve_result.is_ok(), "approve precondition failed");

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
    let result = send(&mut svm, &owner, reimburse_ix);
    assert!(
        result.is_err(),
        "reimburse from Approved should have failed"
    );
    assert_error_code(result.unwrap_err(), StocksieError::InvalidStatusTransition);
}

/// `reimburse_buyer` from `Rejected` (terminal) → `InvalidStatusTransition`.
/// A declined request can never be paid out, even by a valid approver.
#[test]
fn reimburse_from_rejected_rejected() {
    let (mut svm, owner) = setup_svm();
    let (parent, household_pda, owner_member_pda, parent_member_pda) =
        setup_two_member_household(&mut svm, &owner);

    let request_pda = create_request(
        &mut svm,
        &owner,
        owner_member_pda,
        parent.pubkey(),
        parent_member_pda,
        household_pda,
    );

    // Drive Pending → Rejected (terminal).
    let reject_ix = build_ix(
        &stocksie::accounts::RejectPurchaseRequest {
            household: household_pda,
            caller_member: owner_member_pda,
            request: request_pda,
            caller: owner.pubkey(),
        },
        &stocksie::instruction::RejectPurchaseRequest {
            reason_hash: [0u8; 32],
        },
    );
    let reject_result = send(&mut svm, &owner, reject_ix);
    assert!(reject_result.is_ok(), "reject precondition failed");

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
    let result = send(&mut svm, &owner, reimburse_ix);
    assert!(
        result.is_err(),
        "reimburse from Rejected should have failed"
    );
    assert_error_code(result.unwrap_err(), StocksieError::InvalidStatusTransition);
}

// ===========================================================================
// Value-guard tests — `transition_reimbursed` ceiling + zero arms
// ===========================================================================

/// `reimburse_buyer` with `lamports > amount_lamports` →
/// `ReimbursementExceedsApproved`. The approved amount (`REQUEST_AMOUNT_LAMPORTS`)
/// is the immutable ceiling; one lamport over trips the guard before any SOL moves.
#[test]
fn reimburse_over_ceiling() {
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

    // One lamport above the recorded ceiling.
    let over_ceiling = REQUEST_AMOUNT_LAMPORTS + 1;
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
            lamports: over_ceiling,
        },
    );
    let result = send(&mut svm, &owner, reimburse_ix);
    assert!(result.is_err(), "over-ceiling reimburse should have failed");
    assert_error_code(
        result.unwrap_err(),
        StocksieError::ReimbursementExceedsApproved,
    );
}

/// `reimburse_buyer` with `lamports == 0` → `ZeroWithdrawal`. A zero payout
/// would be a no-op move; `transition_reimbursed` rejects it explicitly so the
/// error is unambiguous (rather than relying on `debit_vault`'s own zero guard).
#[test]
fn reimburse_zero() {
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

    let reimburse_ix = build_ix(
        &stocksie::accounts::ReimburseBuyer {
            household: household_pda,
            caller_member: owner_member_pda,
            request: request_pda,
            buyer_member: parent_member_pda,
            buyer: parent.pubkey(),
            caller: owner.pubkey(),
        },
        &stocksie::instruction::ReimburseBuyer { lamports: 0 },
    );
    let result = send(&mut svm, &owner, reimburse_ix);
    assert!(result.is_err(), "zero reimburse should have failed");
    assert_error_code(result.unwrap_err(), StocksieError::ZeroWithdrawal);
}

/// Reimbursing a request that is already `Reimbursed` → `AlreadyReimbursed`.
/// The dedicated arm (rather than the generic `InvalidStatusTransition`) lets
/// the UI distinguish "you already paid this" from "this was never restocked".
#[test]
fn double_reimburse() {
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

    // First reimbursement: Restocked → Reimbursed (valid).
    let first_ix = build_ix(
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
    let first = send(&mut svm, &owner, first_ix);
    assert!(
        first.is_ok(),
        "first reimburse precondition failed:\n{}",
        first.as_ref().unwrap_err().meta.pretty_logs()
    );

    // Second reimbursement: Reimbursed → AlreadyReimbursed.
    //
    // Expire the blockhash first so the replayed tx signs with a fresh
    // blockhash and produces a distinct signature — otherwise LiteSVM's
    // sigverify history rejects it as `AlreadyProcessed` (a duplicate of the
    // first tx) before the program even runs, masking the `AlreadyReimbursed`
    // guard we want to assert.
    svm.expire_blockhash();
    let second_ix = build_ix(
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
    let result = send(&mut svm, &owner, second_ix);
    assert!(result.is_err(), "double reimburse should have failed");
    assert_error_code(result.unwrap_err(), StocksieError::AlreadyReimbursed);
}

// ===========================================================================
// Solvency test — `debit_vault` rejects when the vault cannot cover the payout
// ===========================================================================

/// `reimburse_buyer` when the vault holds fewer lamports than the payout →
/// `InsufficientVaultFunds`. The transition guard passes (status `Restocked`,
/// in-range, non-zero), then `Household::debit_vault` checks
/// `lamports > vault_balance` and reverts. Solana's transaction atomicity
/// guarantees no state mutation and no partial SOL movement leaks through.
///
/// Strategy: start from the standard funded household (vault =
/// `DEPOSIT_LAMPORTS`), reach `Restocked`, then drain the vault via the
/// Owner-only `withdraw_funds` down to a small residual. The subsequent
/// reimbursement exceeds the residual but stays within the approved ceiling,
/// so the *only* failing guard is the vault-solvency one.
#[test]
fn reimburse_insufficient_vault() {
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

    // Drain the vault to a small residual that is strictly less than the
    // payout we will request. After this, `vault_balance == residual`.
    let residual: u64 = 1_000_000; // 0.001 SOL
    let drain = DEPOSIT_LAMPORTS - residual;
    let withdraw_ix = build_ix(
        &stocksie::accounts::WithdrawFunds {
            household: household_pda,
            caller_member: owner_member_pda,
            owner: owner.pubkey(),
            system_program: SYSTEM_PROGRAM_ID,
        },
        &stocksie::instruction::WithdrawFunds { lamports: drain },
    );
    let drain_result = send(&mut svm, &owner, withdraw_ix);
    assert!(
        drain_result.is_ok(),
        "vault drain precondition failed:\n{}",
        drain_result.as_ref().unwrap_err().meta.pretty_logs()
    );

    // Payout is greater than the residual vault balance but well within the
    // approved ceiling, so the transition guard passes and `debit_vault`
    // is what fails.
    let payout = REQUEST_AMOUNT_LAMPORTS / 2; // 0.05 SOL — well above residual, below ceiling
    let reimburse_ix = build_ix(
        &stocksie::accounts::ReimburseBuyer {
            household: household_pda,
            caller_member: owner_member_pda,
            request: request_pda,
            buyer_member: parent_member_pda,
            buyer: parent.pubkey(),
            caller: owner.pubkey(),
        },
        &stocksie::instruction::ReimburseBuyer { lamports: payout },
    );
    let result = send(&mut svm, &owner, reimburse_ix);
    assert!(
        result.is_err(),
        "reimburse with insufficient vault should have failed"
    );
    assert_error_code(result.unwrap_err(), StocksieError::InsufficientVaultFunds);
}
