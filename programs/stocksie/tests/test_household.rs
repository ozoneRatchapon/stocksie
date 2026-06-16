//! Phase 7 — household-lifecycle smoke tests (LiteSVM).
//!
//! These four tests are the smallest end-to-end proof that the build is
//! testable: the harness loads the real `stocksie.so`, drives
//! `initialize_household` / `add_member` / `remove_member` through actual PDAs,
//! and asserts on real account state, events, and balances. They are the
//! "first light" gate required by `plan/09_build_phases.md` Phase 7 before the
//! deeper matrices of Phases 8–9 are written.
//!
//! Coverage (`plan/08_testing.md` §3.2):
//!  1. `initialize_household_creates_pdas` — Household + owner Member exist
//!     with correct fields.
//!  2. `initialize_household_emits_two_events` — `HouseholdCreated` +
//!     `MemberAdded` (role `Owner`) appear in logs.
//!  3. `add_member_increments_count` — `member_count` goes 1 → 2; new Member
//!     carries the supplied role.
//!  4. `remove_member_refunds_rent` — `member_count` decreases; caller balance
//!     increases by exactly the closed account's rent.

#![cfg(not(target_os = "solana"))]

mod helpers;

use anchor_lang::Space;
use helpers::{
    account_of, balance_of, build_ix, derive_household, derive_member, emitted_events_of, send,
    setup_svm, Keypair, SYSTEM_PROGRAM_ID,
};
use solana_signer::Signer;
use stocksie::events::{HouseholdCreated, MemberAdded, MemberRemoved};
use stocksie::state::{Household, Member};
use stocksie::types::Role;

/// Deterministic blake3-sized fixture for the household name hash. Privacy-only
/// reference per the design; value is arbitrary but consistent across tests.
const NAME_HASH: [u8; 32] = [0x42; 32];

// ---------------------------------------------------------------------------
// Test 1 — initialize_household_creates_pdas
// ---------------------------------------------------------------------------

#[test]
fn initialize_household_creates_pdas() {
    let (mut svm, owner) = setup_svm();
    let owner_pk = owner.pubkey();

    let (household_pda, _) = derive_household(&owner_pk);
    let (owner_member_pda, _) = derive_member(&household_pda, &owner_pk);

    let ix = build_ix(
        &stocksie::accounts::InitializeHousehold {
            household: household_pda,
            owner_member: owner_member_pda,
            owner: owner_pk,
            system_program: SYSTEM_PROGRAM_ID,
        },
        &stocksie::instruction::InitializeHousehold {
            name_hash: NAME_HASH,
        },
    );
    let result = send(&mut svm, &owner, ix);
    assert!(
        result.is_ok(),
        "initialize_household failed:\n{}",
        result.as_ref().unwrap_err().meta.pretty_logs()
    );

    // --- Household PDA: correct owner, name_hash, member_count, bumps ---
    let household: Household =
        account_of(&svm, &household_pda).expect("household PDA should exist after init");
    assert_eq!(household.owner, owner_pk);
    assert_eq!(household.name_hash, NAME_HASH);
    assert_eq!(household.member_count, 1, "owner is the first member");
    assert_eq!(household.request_counter, 0);
    assert_eq!(household.total_rewards_distributed, 0);
    assert_eq!(household.vault_balance, 0);
    // `created_slot` is verified against `owner_member.joined_slot` below —
    // both are stamped from one `Clock::get()` in the init handler, so they
    // must be equal. LiteSVM's fresh clock reports slot 0, so `> 0` would be
    // a test-environment artifact rather than a real invariant.

    // --- Owner Member PDA: Owner role, active, correct back-references ---
    let owner_member: Member =
        account_of(&svm, &owner_member_pda).expect("owner member PDA should exist after init");
    assert_eq!(owner_member.household, household_pda);
    assert_eq!(owner_member.wallet, owner_pk);
    assert_eq!(owner_member.role, Role::Owner);
    assert_eq!(owner_member.reward_points, 0);
    assert!(owner_member.active);
    assert_eq!(
        household.created_slot, owner_member.joined_slot,
        "created_slot and joined_slot are stamped from the same Clock::get() in init"
    );
}

// ---------------------------------------------------------------------------
// Test 2 — initialize_household_emits_two_events
// ---------------------------------------------------------------------------

#[test]
fn initialize_household_emits_two_events() {
    let (mut svm, owner) = setup_svm();
    let owner_pk = owner.pubkey();
    let (household_pda, _) = derive_household(&owner_pk);
    let (owner_member_pda, _) = derive_member(&household_pda, &owner_pk);

    let ix = build_ix(
        &stocksie::accounts::InitializeHousehold {
            household: household_pda,
            owner_member: owner_member_pda,
            owner: owner_pk,
            system_program: SYSTEM_PROGRAM_ID,
        },
        &stocksie::instruction::InitializeHousehold {
            name_hash: NAME_HASH,
        },
    );
    let result = send(&mut svm, &owner, ix);
    assert!(result.is_ok());

    // Exactly one HouseholdCreated, carrying the on-chain household + owner.
    let created: Vec<HouseholdCreated> = emitted_events_of(&result);
    assert_eq!(
        created.len(),
        1,
        "initialize_household should emit exactly one HouseholdCreated"
    );
    assert_eq!(created[0].household, household_pda);
    assert_eq!(created[0].owner, owner_pk);
    assert_eq!(created[0].name_hash, NAME_HASH);

    // Exactly one MemberAdded for the owner, with the Owner role.
    let added: Vec<MemberAdded> = emitted_events_of(&result);
    assert_eq!(
        added.len(),
        1,
        "initialize_household should emit exactly one MemberAdded"
    );
    assert_eq!(added[0].household, household_pda);
    assert_eq!(added[0].member, owner_pk);
    assert_eq!(added[0].role, Role::Owner);

    // Both events share the same slot (atomic in one tx).
    assert_eq!(created[0].slot, added[0].slot);
}

// ---------------------------------------------------------------------------
// Test 3 — add_member_increments_count
// ---------------------------------------------------------------------------

#[test]
fn add_member_increments_count() {
    let (mut svm, owner) = setup_svm();
    let owner_pk = owner.pubkey();
    let (household_pda, _) = derive_household(&owner_pk);
    let (owner_member_pda, _) = derive_member(&household_pda, &owner_pk);

    // --- Establish: initialize household (member_count starts at 1) ---
    let init_ix = build_ix(
        &stocksie::accounts::InitializeHousehold {
            household: household_pda,
            owner_member: owner_member_pda,
            owner: owner_pk,
            system_program: SYSTEM_PROGRAM_ID,
        },
        &stocksie::instruction::InitializeHousehold {
            name_hash: NAME_HASH,
        },
    );
    let init_result = send(&mut svm, &owner, init_ix);
    assert!(init_result.is_ok(), "init precondition failed");

    // --- Act: owner adds a Child member (new_member_wallet need not sign) ---
    let new_wallet = Keypair::new().pubkey();
    let (new_member_pda, _) = derive_member(&household_pda, &new_wallet);
    let add_ix = build_ix(
        &stocksie::accounts::AddMember {
            household: household_pda,
            caller_member: owner_member_pda,
            new_member: new_member_pda,
            caller: owner_pk,
            system_program: SYSTEM_PROGRAM_ID,
        },
        &stocksie::instruction::AddMember {
            new_member_wallet: new_wallet,
            role: Role::Child,
        },
    );
    let add_result = send(&mut svm, &owner, add_ix);
    assert!(
        add_result.is_ok(),
        "add_member failed:\n{}",
        add_result.as_ref().unwrap_err().meta.pretty_logs()
    );

    // --- Assert: member_count 1 → 2 ---
    let household: Household =
        account_of(&svm, &household_pda).expect("household PDA must still exist");
    assert_eq!(household.member_count, 2);

    // --- Assert: new Member has the supplied role and correct back-refs ---
    let new_member: Member =
        account_of(&svm, &new_member_pda).expect("new member PDA should exist after add");
    assert_eq!(new_member.household, household_pda);
    assert_eq!(new_member.wallet, new_wallet);
    assert_eq!(new_member.role, Role::Child);
    assert!(new_member.active);
    assert_eq!(new_member.reward_points, 0);
    // Monotonicity: the add tx runs after init, so the new member's joined
    // slot must be >= the household's creation slot. Fresh LiteSVM keeps both
    // at 0, so `> 0` would not be a meaningful smoke-test assertion here.
    assert!(
        new_member.joined_slot >= household.created_slot,
        "joined_slot ({}) should be >= created_slot ({})",
        new_member.joined_slot,
        household.created_slot
    );

    // --- Assert: a MemberAdded event was emitted for the new wallet ---
    let added: Vec<MemberAdded> = emitted_events_of(&add_result);
    assert_eq!(added.len(), 1);
    assert_eq!(added[0].member, new_wallet);
    assert_eq!(added[0].role, Role::Child);
    assert_eq!(added[0].household, household_pda);
}

// ---------------------------------------------------------------------------
// Test 4 — remove_member_refunds_rent
// ---------------------------------------------------------------------------

#[test]
fn remove_member_refunds_rent() {
    let (mut svm, owner) = setup_svm();
    let owner_pk = owner.pubkey();
    let (household_pda, _) = derive_household(&owner_pk);
    let (owner_member_pda, _) = derive_member(&household_pda, &owner_pk);

    // --- Establish: init + add a Child member ---
    let init_ix = build_ix(
        &stocksie::accounts::InitializeHousehold {
            household: household_pda,
            owner_member: owner_member_pda,
            owner: owner_pk,
            system_program: SYSTEM_PROGRAM_ID,
        },
        &stocksie::instruction::InitializeHousehold {
            name_hash: NAME_HASH,
        },
    );
    assert!(send(&mut svm, &owner, init_ix).is_ok());

    let new_wallet = Keypair::new().pubkey();
    let (new_member_pda, _) = derive_member(&household_pda, &new_wallet);
    let add_ix = build_ix(
        &stocksie::accounts::AddMember {
            household: household_pda,
            caller_member: owner_member_pda,
            new_member: new_member_pda,
            caller: owner_pk,
            system_program: SYSTEM_PROGRAM_ID,
        },
        &stocksie::instruction::AddMember {
            new_member_wallet: new_wallet,
            role: Role::Child,
        },
    );
    assert!(send(&mut svm, &owner, add_ix).is_ok());

    // Rent due on a Member PDA: 8-byte discriminator + Member::INIT_SPACE.
    // Capture the exact figure pre-close so the refund assertion is robust to
    // any future rent-rate change.
    let member_rent = helpers::rent_lamports(&svm, 8 + Member::INIT_SPACE);

    // Caller balance *after* paying rent for the new Member, *before* removal.
    let caller_balance_before = balance_of(&svm, &owner_pk);

    // --- Act: owner removes the added member (close refunds `caller`) ---
    let remove_ix = build_ix(
        &stocksie::accounts::RemoveMember {
            household: household_pda,
            caller_member: owner_member_pda,
            target_member: new_member_pda,
            caller: owner_pk,
        },
        &stocksie::instruction::RemoveMember {
            member_wallet: new_wallet,
        },
    );
    let remove_result = send(&mut svm, &owner, remove_ix);
    assert!(
        remove_result.is_ok(),
        "remove_member failed:\n{}",
        remove_result.as_ref().unwrap_err().meta.pretty_logs()
    );

    // --- Assert: member_count 2 → 1 ---
    let household: Household =
        account_of(&svm, &household_pda).expect("household must still exist after remove");
    assert_eq!(household.member_count, 1);

    // --- Assert: Member PDA is closed (account gone) ---
    assert!(
        svm.get_account(&new_member_pda).is_none(),
        "target Member PDA should be closed (rent reclaimed, account wiped)"
    );

    // --- Assert: caller balance increased by Member rent MINUS the tx fee ---
    // The `close = caller` constraint refunds the Member PDA rent to the
    // caller, but the payer (also `caller`) is charged the transaction fee, so
    // the net change is `+member_rent - fee` (LiteSVM's default fee is 5000
    // lamports, visible via `TransactionMetadata::fee`).
    let remove_fee = remove_result.as_ref().unwrap().fee;
    let caller_balance_after = balance_of(&svm, &owner_pk);
    assert_eq!(
        caller_balance_after,
        caller_balance_before + member_rent - remove_fee,
        "close should refund Member PDA rent ({}) minus tx fee ({}); got delta {}",
        member_rent,
        remove_fee,
        caller_balance_after as i64 - caller_balance_before as i64
    );

    // --- Assert: MemberRemoved event emitted for the right wallet ---
    let removed: Vec<MemberRemoved> = emitted_events_of(&remove_result);
    assert_eq!(removed.len(), 1);
    assert_eq!(removed[0].member, new_wallet);
    assert_eq!(removed[0].household, household_pda);
}
