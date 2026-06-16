//! Phase 8 — permission, role-gate, and forbidden-transition tests (LiteSVM).
//!
//! Two complementary negative-test groups live here:
//!
//! 1. **Role / authority gates** — every access-controlled instruction must
//!    reject callers whose role lacks the required privilege, and a handful of
//!    domain rules (`SelfApprovalForbidden`, `NotBuyer`, `CannotModifyOwner`)
//!    must reject even otherwise-privileged signers. Asserting the *exact*
//!    `StocksieError` code (not just `.is_err()`) proves the intended guard
//!    fired — a generic failure could mask an unrelated bug.
//!
//! 2. **Forbidden status transitions** — the non-reimburse half of the
//!    `05_state_machine.md` §4 matrix: `confirm_restock`/`reject`/`approve`
//!    called from a state that does not permit them must revert with
//!    `InvalidStatusTransition`. The reimburse-specific forbidden cases
//!    (`Pending`/`Approved`/`Rejected` → reimburse, over-ceiling, zero, and
//!    `AlreadyReimbursed`) live in `test_reimburse.rs` so each file owns one
//!    coherent instruction surface.
//!
//! Coverage map (`plan/08_testing.md`):
//!   - `child_cannot_approve`               → `UnauthorizedRole`
//!   - `child_cannot_reimburse`             → `UnauthorizedRole`
//!   - `child_cannot_award_reward`          → `UnauthorizedRole`
//!   - `parent_cannot_withdraw_funds`       → `UnauthorizedRole`
//!   - `buyer_cannot_approve_own_request`   → `SelfApprovalForbidden`
//!   - `non_buyer_cannot_confirm_restock`   → `NotBuyer`
//!   - `add_member_with_owner_role_rejected`→ `CannotModifyOwner`
//!   - `remove_owner_rejected`              → `CannotModifyOwner`
//!   - `set_role_to_owner_rejected`         → `CannotModifyOwner`
//!   - `confirm_restock_from_pending_rejected` → `InvalidStatusTransition`
//!   - `reject_from_restocked_rejected`        → `InvalidStatusTransition`
//!   - `reject_from_reimbursed_rejected`       → `InvalidStatusTransition`
//!   - `reject_from_rejected_rejected`         → `InvalidStatusTransition`
//!   - `approve_from_approved_rejected`        → `InvalidStatusTransition`
//!   - `approve_from_terminal_rejected`        → `InvalidStatusTransition`
//!
//! The remaining (reimburse) half of the forbidden-transition matrix and the
//! 8 structurally-unreachable `StocksieError` variants are documented at the
//! bottom of this file.

#![cfg(not(target_os = "solana"))]

mod helpers;

// Shared fixtures and the multi-step scenario helpers
// (`setup_two_member_household`, `reach_restocked`, `reach_reimbursed`,
// `add_member`) live in the harness so every Phase 8 file composes the same
// building blocks (DRY).
use helpers::{
    add_member, assert_error_code, build_ix, derive_member, derive_request, reach_reimbursed,
    reach_restocked, send, setup_svm, setup_two_member_household, Keypair, Pubkey, ITEM_HASH,
    REIMBURSE_LAMPORTS, REQUEST_AMOUNT_LAMPORTS, SYSTEM_PROGRAM_ID, UNIT_COST_HASH,
};
use litesvm::LiteSVM;
use solana_signer::Signer;
use stocksie::error::StocksieError;
use stocksie::types::Role;

// ===========================================================================
// Local scenario helpers
// ===========================================================================

/// Set up a three-member household: `Owner` (from `setup_svm`) + `Parent`
/// (buyer, funded) + `Child` (funded so it can sign as a forbidden caller).
///
/// Returns
/// `(parent_kp, child_kp, household_pda, owner_member_pda, parent_member_pda, child_member_pda)`.
fn setup_three_member_household(
    svm: &mut LiteSVM,
    owner: &Keypair,
) -> (Keypair, Keypair, Pubkey, Pubkey, Pubkey, Pubkey) {
    let (parent, household_pda, owner_member_pda, parent_member_pda) =
        setup_two_member_household(svm, owner);

    // Fund the Child so it can be the tx payer when it attempts a forbidden
    // instruction (LiteSVM charges the payer the tx fee and any rent).
    let child = Keypair::new();
    let child_pk = child.pubkey();
    svm.airdrop(&child_pk, 10_000_000_000)
        .expect("airdrop of child funds failed");
    let child_member_pda = add_member(
        svm,
        owner,
        household_pda,
        owner_member_pda,
        child_pk,
        Role::Child,
    );

    (
        parent,
        child,
        household_pda,
        owner_member_pda,
        parent_member_pda,
        child_member_pda,
    )
}

/// Create a `PurchaseRequest` in the `Pending` state and return its PDA.
///
/// `reporter` signs (and pays rent); `buyer` is the designated shopper (must
/// be an active transacting member). The `request_id` is always `1` here
/// because every test starts from a fresh SVM with `request_counter = 0`.
fn create_request(
    svm: &mut LiteSVM,
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
// Group 1 — role / authority gates
// ===========================================================================

/// A `Child` (active member, but `can_approve() == false`) must not approve a
/// purchase request. The role constraint on `caller_member` fires during
/// account validation, before the handler's status check.
#[test]
fn child_cannot_approve() {
    let (mut svm, owner) = setup_svm();
    let (parent, child, household_pda, owner_member_pda, parent_member_pda, child_member_pda) =
        setup_three_member_household(&mut svm, &owner);

    // Owner reports a request naming the Parent as buyer → Pending.
    let request_pda = create_request(
        &mut svm,
        &owner,
        owner_member_pda,
        parent.pubkey(),
        parent_member_pda,
        household_pda,
    );

    // Child (active member, role Child) attempts to approve.
    let approve_ix = build_ix(
        &stocksie::accounts::ApprovePurchaseRequest {
            household: household_pda,
            caller_member: child_member_pda,
            request: request_pda,
            caller: child.pubkey(),
        },
        &stocksie::instruction::ApprovePurchaseRequest {},
    );
    let result = send(&mut svm, &child, approve_ix);
    assert!(result.is_err(), "Child approve should have failed");
    assert_error_code(result.unwrap_err(), StocksieError::UnauthorizedRole);
}

/// A `Child` must not reimburse a buyer. `reimburse_buyer`'s `caller_member`
/// constraint requires `can_approve()` (Owner/Parent only).
#[test]
fn child_cannot_reimburse() {
    let (mut svm, owner) = setup_svm();
    let (parent, child, household_pda, owner_member_pda, parent_member_pda, child_member_pda) =
        setup_three_member_household(&mut svm, &owner);

    // Drive to Restocked so the only failing guard is the role gate (the
    // status transition would otherwise be valid here).
    let request_pda = reach_restocked(
        &mut svm,
        &owner,
        &parent,
        household_pda,
        owner_member_pda,
        parent_member_pda,
    );

    // Child attempts to reimburse the Parent (the recorded buyer).
    let reimburse_ix = build_ix(
        &stocksie::accounts::ReimburseBuyer {
            household: household_pda,
            caller_member: child_member_pda,
            request: request_pda,
            buyer_member: parent_member_pda,
            buyer: parent.pubkey(),
            caller: child.pubkey(),
        },
        &stocksie::instruction::ReimburseBuyer {
            lamports: REIMBURSE_LAMPORTS,
        },
    );
    let result = send(&mut svm, &child, reimburse_ix);
    assert!(result.is_err(), "Child reimburse should have failed");
    assert_error_code(result.unwrap_err(), StocksieError::UnauthorizedRole);
}

/// A `Child` must not manually award reward points. `award_reward`'s
/// `caller_member` constraint requires `can_award_rewards()` (Owner/Parent).
#[test]
fn child_cannot_award_reward() {
    let (mut svm, owner) = setup_svm();
    let (parent, child, household_pda, _owner_member_pda, parent_member_pda, child_member_pda) =
        setup_three_member_household(&mut svm, &owner);

    let award_ix = build_ix(
        &stocksie::accounts::AwardReward {
            household: household_pda,
            caller_member: child_member_pda,
            target_member: parent_member_pda,
            caller: child.pubkey(),
        },
        &stocksie::instruction::AwardReward {
            member_wallet: parent.pubkey(),
            points: 5,
            reason_hash: [0x11u8; 32],
        },
    );
    let result = send(&mut svm, &child, award_ix);
    assert!(result.is_err(), "Child award_reward should have failed");
    assert_error_code(result.unwrap_err(), StocksieError::UnauthorizedRole);
}

/// A `Parent` must not drain the vault directly — routine spending must go
/// through the approval + reimbursement pipeline. `withdraw_funds` is gated to
/// `can_withdraw_funds()` (Owner only). The constraint fires during validation,
/// before the handler's zero/owner checks.
#[test]
fn parent_cannot_withdraw_funds() {
    let (mut svm, owner) = setup_svm();
    let (parent, household_pda, _owner_member_pda, parent_member_pda) =
        setup_two_member_household(&mut svm, &owner);

    // Parent signs as the `owner` signer field; the seed derives the Parent's
    // own member PDA, whose role fails `can_withdraw_funds()`.
    let withdraw_ix = build_ix(
        &stocksie::accounts::WithdrawFunds {
            household: household_pda,
            caller_member: parent_member_pda,
            owner: parent.pubkey(),
            system_program: SYSTEM_PROGRAM_ID,
        },
        &stocksie::instruction::WithdrawFunds { lamports: 1_000 },
    );
    let result = send(&mut svm, &parent, withdraw_ix);
    assert!(result.is_err(), "Parent withdraw should have failed");
    assert_error_code(result.unwrap_err(), StocksieError::UnauthorizedRole);
}

/// Separation of duties: an approver may not approve their own request. The
/// reporter here is the Parent (so the caller_member and buyer_member PDAs are
/// distinct accounts), and the buyer is the Owner. When the Owner then tries
/// to approve, `caller == buyer` → `SelfApprovalForbidden`.
#[test]
fn buyer_cannot_approve_own_request() {
    let (mut svm, owner) = setup_svm();
    let (parent, household_pda, owner_member_pda, parent_member_pda) =
        setup_two_member_household(&mut svm, &owner);

    // Parent reports a request naming the Owner as buyer → Pending.
    let request_pda = create_request(
        &mut svm,
        &parent,
        parent_member_pda,
        owner.pubkey(),
        owner_member_pda,
        household_pda,
    );

    // Owner (the recorded buyer, and a valid approver by role) attempts to
    // approve their own request.
    let approve_ix = build_ix(
        &stocksie::accounts::ApprovePurchaseRequest {
            household: household_pda,
            caller_member: owner_member_pda,
            request: request_pda,
            caller: owner.pubkey(),
        },
        &stocksie::instruction::ApprovePurchaseRequest {},
    );
    let result = send(&mut svm, &owner, approve_ix);
    assert!(result.is_err(), "Self-approval should have failed");
    assert_error_code(result.unwrap_err(), StocksieError::SelfApprovalForbidden);
}

/// Only the recorded buyer may confirm a restock. Here an active `Child`
/// member signs `confirm_restock` as the `buyer`; the `buyer_member` PDA is
/// therefore the Child's own PDA, so `request.buyer != buyer_member.wallet`
/// trips the `NotBuyer` constraint during validation.
#[test]
fn non_buyer_cannot_confirm_restock() {
    let (mut svm, owner) = setup_svm();
    let (parent, child, household_pda, owner_member_pda, parent_member_pda, child_member_pda) =
        setup_three_member_household(&mut svm, &owner);

    // Owner creates a request naming the Parent as buyer, then approves it.
    let request_pda = create_request(
        &mut svm,
        &owner,
        owner_member_pda,
        parent.pubkey(),
        parent_member_pda,
        household_pda,
    );
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

    // Child (active member, but NOT the recorded buyer) signs confirm_restock.
    let confirm_ix = build_ix(
        &stocksie::accounts::ConfirmRestock {
            household: household_pda,
            buyer_member: child_member_pda,
            request: request_pda,
            buyer: child.pubkey(),
        },
        &stocksie::instruction::ConfirmRestock {
            unit_cost_hash: UNIT_COST_HASH,
        },
    );
    let result = send(&mut svm, &child, confirm_ix);
    assert!(result.is_err(), "Non-buyer confirm should have failed");
    assert_error_code(result.unwrap_err(), StocksieError::NotBuyer);
}

/// `add_member` rejects `role == Owner`: a household has exactly one owner,
/// set exclusively by `initialize_household`. The handler returns
/// `CannotModifyOwner`; the rent-charged `init` is reverted atomically.
#[test]
fn add_member_with_owner_role_rejected() {
    let (mut svm, owner) = setup_svm();
    let (_parent, household_pda, owner_member_pda, _parent_member_pda) =
        setup_two_member_household(&mut svm, &owner);

    let new_wallet = Keypair::new().pubkey();
    let (new_member_pda, _) = derive_member(&household_pda, &new_wallet);
    let add_ix = build_ix(
        &stocksie::accounts::AddMember {
            household: household_pda,
            caller_member: owner_member_pda,
            new_member: new_member_pda,
            caller: owner.pubkey(),
            system_program: SYSTEM_PROGRAM_ID,
        },
        &stocksie::instruction::AddMember {
            new_member_wallet: new_wallet,
            role: Role::Owner,
        },
    );
    let result = send(&mut svm, &owner, add_ix);
    assert!(
        result.is_err(),
        "add_member with Owner role should have failed"
    );
    assert_error_code(result.unwrap_err(), StocksieError::CannotModifyOwner);
}

/// `remove_member` may not target the household Owner. The
/// `target_member.role != Role::Owner` constraint fires during validation
/// (before the `close` logic), so `CannotModifyOwner` is returned even though
/// the caller (necessarily the Owner, the only role with `can_manage_members`)
/// is here targeting their own member PDA.
#[test]
fn remove_owner_rejected() {
    let (mut svm, owner) = setup_svm();
    let (_parent, household_pda, owner_member_pda, _parent_member_pda) =
        setup_two_member_household(&mut svm, &owner);

    let remove_ix = build_ix(
        &stocksie::accounts::RemoveMember {
            household: household_pda,
            caller_member: owner_member_pda,
            target_member: owner_member_pda,
            caller: owner.pubkey(),
        },
        &stocksie::instruction::RemoveMember {
            member_wallet: owner.pubkey(),
        },
    );
    let result = send(&mut svm, &owner, remove_ix);
    assert!(result.is_err(), "remove_owner should have failed");
    assert_error_code(result.unwrap_err(), StocksieError::CannotModifyOwner);
}

/// `set_role` rejects promotion to `Owner`. Targeting a non-owner member
/// (the Parent) keeps `caller_member` and `target_member` distinct; the
/// handler returns `CannotModifyOwner` for `new_role == Owner`.
#[test]
fn set_role_to_owner_rejected() {
    let (mut svm, owner) = setup_svm();
    let (parent, household_pda, owner_member_pda, parent_member_pda) =
        setup_two_member_household(&mut svm, &owner);

    let set_role_ix = build_ix(
        &stocksie::accounts::SetRole {
            household: household_pda,
            caller_member: owner_member_pda,
            target_member: parent_member_pda,
            caller: owner.pubkey(),
        },
        &stocksie::instruction::SetRole {
            new_role: Role::Owner,
            member_wallet: parent.pubkey(),
        },
    );
    let result = send(&mut svm, &owner, set_role_ix);
    assert!(result.is_err(), "set_role to Owner should have failed");
    assert_error_code(result.unwrap_err(), StocksieError::CannotModifyOwner);
}

// ===========================================================================
// Group 2 — forbidden status transitions (non-reimburse)
// ===========================================================================

/// `confirm_restock` from `Pending` (skipping approval) →
/// `InvalidStatusTransition`. The recorded buyer signs, so the only failing
/// guard is the lifecycle one.
#[test]
fn confirm_restock_from_pending_rejected() {
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

    // Buyer tries to confirm without an approval.
    let confirm_ix = build_ix(
        &stocksie::accounts::ConfirmRestock {
            household: household_pda,
            buyer_member: parent_member_pda,
            request: request_pda,
            buyer: parent.pubkey(),
        },
        &stocksie::instruction::ConfirmRestock {
            unit_cost_hash: UNIT_COST_HASH,
        },
    );
    let result = send(&mut svm, &parent, confirm_ix);
    assert!(result.is_err(), "confirm from Pending should have failed");
    assert_error_code(result.unwrap_err(), StocksieError::InvalidStatusTransition);
}

/// `reject_purchase_request` from `Restocked` → `InvalidStatusTransition`.
/// Once the buyer has shopped, an approver may no longer unwind the request.
#[test]
fn reject_from_restocked_rejected() {
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
    let result = send(&mut svm, &owner, reject_ix);
    assert!(result.is_err(), "reject from Restocked should have failed");
    assert_error_code(result.unwrap_err(), StocksieError::InvalidStatusTransition);
}

/// `reject_purchase_request` from `Reimbursed` (terminal) →
/// `InvalidStatusTransition`. Terminal states are frozen.
#[test]
fn reject_from_reimbursed_rejected() {
    let (mut svm, owner) = setup_svm();
    let (parent, household_pda, owner_member_pda, parent_member_pda) =
        setup_two_member_household(&mut svm, &owner);
    let request_pda = reach_reimbursed(
        &mut svm,
        &owner,
        &parent,
        household_pda,
        owner_member_pda,
        parent_member_pda,
    );

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
    let result = send(&mut svm, &owner, reject_ix);
    assert!(result.is_err(), "reject from Reimbursed should have failed");
    assert_error_code(result.unwrap_err(), StocksieError::InvalidStatusTransition);
}

/// `reject_purchase_request` from `Rejected` (already terminal) →
/// `InvalidStatusTransition`. Idempotency: a second reject must not move state.
#[test]
fn reject_from_rejected_rejected() {
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

    // First reject: Pending → Rejected (terminal).
    let reject_once = build_ix(
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
    let first = send(&mut svm, &owner, reject_once);
    assert!(first.is_ok(), "first reject precondition failed");

    // Second reject: Rejected → InvalidStatusTransition.
    //
    // Expire the blockhash first so the replayed tx signs with a fresh
    // blockhash and produces a distinct signature — otherwise LiteSVM's
    // sigverify history rejects it as `AlreadyProcessed` (a duplicate of the
    // first tx) before the program even runs, masking the
    // `InvalidStatusTransition` guard we want to assert.
    svm.expire_blockhash();
    let reject_again = build_ix(
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
    let result = send(&mut svm, &owner, reject_again);
    assert!(result.is_err(), "second reject should have failed");
    assert_error_code(result.unwrap_err(), StocksieError::InvalidStatusTransition);
}

/// `approve_purchase_request` from `Approved` (replayed approval) →
/// `InvalidStatusTransition`. No double-effect on a retry.
#[test]
fn approve_from_approved_rejected() {
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

    // First approve: Pending → Approved.
    let approve_once = build_ix(
        &stocksie::accounts::ApprovePurchaseRequest {
            household: household_pda,
            caller_member: owner_member_pda,
            request: request_pda,
            caller: owner.pubkey(),
        },
        &stocksie::instruction::ApprovePurchaseRequest {},
    );
    let first = send(&mut svm, &owner, approve_once);
    assert!(first.is_ok(), "first approve precondition failed");

    // Second approve: Approved → InvalidStatusTransition.
    //
    // Expire the blockhash first so the replayed tx signs with a fresh
    // blockhash and produces a distinct signature — otherwise LiteSVM's
    // sigverify history rejects it as `AlreadyProcessed` (a duplicate of the
    // first tx) before the program even runs, masking the
    // `InvalidStatusTransition` guard we want to assert. `approve` has no
    // args, so unlike `reject` we cannot disambiguate the two txs via a
    // differing `reason_hash` — the blockhash expiry is the only option.
    svm.expire_blockhash();
    let approve_again = build_ix(
        &stocksie::accounts::ApprovePurchaseRequest {
            household: household_pda,
            caller_member: owner_member_pda,
            request: request_pda,
            caller: owner.pubkey(),
        },
        &stocksie::instruction::ApprovePurchaseRequest {},
    );
    let result = send(&mut svm, &owner, approve_again);
    assert!(result.is_err(), "second approve should have failed");
    assert_error_code(result.unwrap_err(), StocksieError::InvalidStatusTransition);
}

/// `approve_purchase_request` from a terminal state (`Rejected`) →
/// `InvalidStatusTransition`. Approving an already-finalised request is
/// forbidden even though the caller is otherwise a valid approver and is not
/// the buyer (so the `SelfApprovalForbidden` guard does not fire).
#[test]
fn approve_from_terminal_rejected() {
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

    // Drive to terminal Rejected.
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

    // Approver (Owner ≠ buyer Parent) tries to approve the terminal request.
    let approve_ix = build_ix(
        &stocksie::accounts::ApprovePurchaseRequest {
            household: household_pda,
            caller_member: owner_member_pda,
            request: request_pda,
            caller: owner.pubkey(),
        },
        &stocksie::instruction::ApprovePurchaseRequest {},
    );
    let result = send(&mut svm, &owner, approve_ix);
    assert!(result.is_err(), "approve from terminal should have failed");
    assert_error_code(result.unwrap_err(), StocksieError::InvalidStatusTransition);
}

// ===========================================================================
// Unreachable variants — honest documentation
// ===========================================================================

/// `StocksieError` variants that are **structurally unreachable** via the
/// instruction surface and therefore have no LiteSVM integration test in this
/// file or anywhere under `tests/`.
///
/// The Phase 8 "done when" criterion requires every variant to be asserted by
/// at least one test. Faking coverage with a placeholder assertion would
/// violate the project's no-placeholder rule, so each entry below documents
/// the structural reason the variant cannot fire from any instruction's
/// account-validation or handler path. They remain in `error.rs` as
/// defence-in-depth (a future refactor that relaxes a seed/constraint would
/// then surface a real test gap rather than silently passing).
#[allow(dead_code)]
mod unreachable_errors {
    // `NotAMember` — every caller-member account is seed-bound to
    // `[MEMBER_SEED, household, caller.key()]` and `has_one = household`. A
    // non-member wallet fails account resolution (AccountNotFound / seed
    // mismatch) before any `@ NotAMember` constraint can be evaluated. No
    // instruction annotates a constraint with `@ NotAMember`.
    //
    // `MemberAlreadyExists` — `add_member` uses Anchor's `init`, whose
    // collision on an existing PDA returns Anchor's generic
    // `AccountDiscriminatorAlreadySet` / `AccountAlreadyInitialized` error,
    // not this variant. No handler returns `MemberAlreadyExists`.
    //
    // `MemberNotFound` — every target-member account is seed-bound to the
    // instruction arg `member_wallet`; a non-member wallet resolves to a
    // non-existent PDA and fails `Account<Member>` deserialisation. The lone
    // `@ MemberNotFound` constraint (`award_reward`) is a data-integrity
    // guard against stored-field corruption, unreachable in normal operation.
    //
    // `MemberInactive` — there is no instruction that flips `active = false`
    // without closing the PDA: `remove_member` uses Anchor's `close`, which
    // wipes the account entirely. Hence every existing `Member` PDA has
    // `active == true`, and the `@ MemberInactive` constraints can never fire.
    //
    // `HouseholdAccountMismatch` — only referenced by `debit_vault`'s
    // vault≠destination alias guard. The accounts structs never route the
    // household PDA as the reimbursement/withdrawal destination, so the alias
    // is structurally prevented at the accounts-struct layer.
    //
    // `HouseholdMismatch` — declared in `error.rs` but not referenced by any
    // constraint or handler. Retained for future cross-account checks.
    //
    // `AlreadyTerminal` — declared in `error.rs` but not referenced; every
    // terminal-state guard uses `InvalidStatusTransition` (or
    // `AlreadyReimbursed` for the dedicated double-pay arm) instead.
    //
    // `Overflow` — every accumulator is bounded above by an upstream
    // constraint before checked arithmetic runs (`MAX_MEMBERS` caps
    // `member_count`; reward paths surface `RewardOverflow` first; the
    // `u64` request counter would need >>10^12 requests). The generic
    // `Overflow` net is defence-in-depth only.
}
