//! Stocksie LiteSVM test harness — shared helpers for integration tests.
//!
//! Every LiteSVM test target (`tests/test_*.rs`) opens with `mod helpers;` and
//! builds instructions via [`build_ix`], executes them via [`send`], and reads
//! back state / events via [`account_of`] / [`emitted_events_of`]. Failed-tx
//! cases funnel through [`assert_error_code`].
//!
//! ## Why a shared harness
//!
//! Anchor + LiteSVM plumbing (keypair funding, blockhash, transaction wiring,
//! event decode, error-code mapping) is identical for every test. Centralising
//! it keeps test bodies declarative and lets the matrix in
//! `plan/08_testing.md` map 1:1 to readable test functions.
//!
//! ## Type compatibility (Agave 3.0)
//!
//! `solana_pubkey::Pubkey` 3.0 is a type alias for `solana_address::Address`
//! (see `solana-pubkey-3.0.0/src/lib.rs`: `pub use solana_address::{Address as
//! Pubkey, ...}`). Anchor 1.0.2 depends on `solana-pubkey` 3.0; LiteSVM 0.10
//! depends on `solana-address` 2.x. Both resolve to the *same* `Address` type
//! in the lockfile, so the program's `Pubkey` and LiteSVM's `Address` are one
//! type — no conversion shims are needed at the Anchor↔LiteSVM boundary
//! (`stocksie::id()` plugs straight into `svm.add_program`, PDA derivation,
//! `svm.get_account`, etc.).
//!
//! ## Hard prerequisite
//!
//! `setup_svm` does `include_bytes!("target/deploy/stocksie.so")`, so a
//! successful `anchor build` is required before any LiteSVM test runs
//! (see `plan/08_testing.md` §8).

// Each integration test target (`test_household`, `test_lifecycle`, etc.)
// compiles this module independently and uses a different subset of helpers.
// A module-level allow suppresses false-positive dead-code warnings for
// helpers that are used by some targets but not others.
#![allow(dead_code)]

use anchor_lang::{
    AccountDeserialize, AnchorDeserialize, Discriminator, Event, InstructionData, ToAccountMetas,
};
use base64::Engine;
use litesvm::types::{FailedTransactionMetadata, TransactionResult};
use litesvm::LiteSVM;
use solana_instruction::error::InstructionError;
use solana_instruction::Instruction;
use solana_message::Message;
use solana_signer::Signer;
use solana_transaction::Transaction;
use solana_transaction_error::TransactionError;
use stocksie::error::StocksieError;
use stocksie::types::Role;
use stocksie::{HOUSEHOLD_SEED, MEMBER_SEED, PURCHASE_SEED};

// Cross-cutting re-exports so test files can get every common type via a single
// `use helpers::*;`. These are the *same* types Anchor/LiteSVM use internally
// (verified via the Agave 3.0 alias chain), so there is no coercion drift.
pub use anchor_lang::solana_program::pubkey::Pubkey;
pub use anchor_lang::solana_program::system_program::ID as SYSTEM_PROGRAM_ID;
pub use solana_keypair::Keypair;

// ---------------------------------------------------------------------------
// Shared test fixtures — deterministic blake3-sized hashes and SOL amounts
// used by every scenario helper and most test files. Centralised so a tweak
// (e.g. raising DEPOSIT_LAMPORTS) lands in one place.
// ---------------------------------------------------------------------------

/// blake3-sized fixture for the household name hash. Privacy-only reference
/// per the design; value is arbitrary but consistent across tests.
pub const NAME_HASH: [u8; 32] = [0x42; 32];

/// blake3-sized fixture for the item name+quantity hash (Feature 3.5 privacy).
pub const ITEM_HASH: [u8; 32] = [0xAB; 32];

/// blake3-sized fixture for the best-value recommendation snapshot hash.
pub const UNIT_COST_HASH: [u8; 32] = [0xCD; 32];

/// 1 SOL — comfortably above any single reimbursement so the vault stays
/// solvent through every lifecycle test.
pub const DEPOSIT_LAMPORTS: u64 = 1_000_000_000;

/// 0.1 SOL — within `[MIN_REQUEST_LAMPORTS, MAX_REIMBURSEMENT_LAMPORTS]`.
pub const REQUEST_AMOUNT_LAMPORTS: u64 = 100_000_000;

/// 0.09 SOL — strictly less than `REQUEST_AMOUNT_LAMPORTS` so the
/// "partial reimbursement" branch is exercised; the buyer is paid out less
/// than the approved ceiling.
pub const REIMBURSE_LAMPORTS: u64 = 90_000_000;

/// Convenience aggregate: low-stock + restock + full-run (50 points).
pub const TOTAL_LIFECYCLE_REWARD: u64 = stocksie::constants::REWARD_LOW_STOCK_REPORT
    + stocksie::constants::REWARD_RESTOCK_COMPLETED
    + stocksie::constants::REWARD_FULL_RUN_COMPLETED;

/// Lamports required to keep an account of `data_len` bytes rent-exempt in the
/// current SVM. Used by rent-refund assertions (e.g. `remove_member` should
/// credit the caller by exactly `rent_lamports(svm, 8 + Member::INIT_SPACE)`).
pub fn rent_lamports(svm: &LiteSVM, data_len: usize) -> u64 {
    svm.minimum_balance_for_rent_exemption(data_len)
}

/// Fresh LiteSVM with the compiled Stocksie program loaded and a 100 SOL payer.
///
/// The `.so` is `include_bytes!`-ed at compile time, so `anchor build` must
/// have produced `target/deploy/stocksie.so` first.
pub fn setup_svm() -> (LiteSVM, Keypair) {
    let mut svm = LiteSVM::new();
    let program_bytes: &[u8] = include_bytes!("../../../../target/deploy/stocksie.so");
    svm.add_program(stocksie::id(), program_bytes)
        .expect("failed to load stocksie.so into LiteSVM");
    let payer = Keypair::new();
    svm.airdrop(&payer.pubkey(), 100_000_000_000) // 100 SOL
        .expect("airdrop of payer funds failed");
    (svm, payer)
}

// ---------------------------------------------------------------------------
// PDA derivation — mirrors `constants.rs` seeds exactly.
// ---------------------------------------------------------------------------

/// Household + vault PDA: `[HOUSEHOLD_SEED, owner]`.
pub fn derive_household(owner: &Pubkey) -> (Pubkey, u8) {
    Pubkey::find_program_address(&[HOUSEHOLD_SEED, owner.as_ref()], &stocksie::id())
}

/// Membership PDA: `[MEMBER_SEED, household, wallet]`.
pub fn derive_member(household: &Pubkey, wallet: &Pubkey) -> (Pubkey, u8) {
    Pubkey::find_program_address(
        &[MEMBER_SEED, household.as_ref(), wallet.as_ref()],
        &stocksie::id(),
    )
}

/// Purchase-request PDA: `[PURCHASE_SEED, household, request_id_le]`.
///
/// Reserved for Phase 8 (purchase-lifecycle tests); not exercised by the
/// Phase 7 household smoke tests, hence the explicit `#[allow(dead_code)]`
/// rather than letting the warning fire until the lifecycle target lands.
pub fn derive_request(household: &Pubkey, request_id: u64) -> (Pubkey, u8) {
    Pubkey::find_program_address(
        &[PURCHASE_SEED, household.as_ref(), &request_id.to_le_bytes()],
        &stocksie::id(),
    )
}

// ---------------------------------------------------------------------------
// Instruction construction + execution
// ---------------------------------------------------------------------------

/// Build a Stocksie instruction from Anchor's generated client surface.
///
/// `accounts` is one of the `stocksie::accounts::*` structs (each impls
/// [`ToAccountMetas`]); `args` is the matching `stocksie::instruction::*`
/// struct (each impls [`InstructionData`], so `.data()` yields the canonical
/// `discriminator(8) ++ borsh(args)` payload that a real wallet would submit).
///
/// ```ignore
/// let ix = build_ix(
///     &stocksie::accounts::InitializeHousehold {
///         household, owner_member, owner: owner.pubkey(),
///         system_program: SYSTEM_PROGRAM_ID,
///     },
///     &stocksie::instruction::InitializeHousehold { name_hash: [1u8; 32] },
/// );
/// ```
pub fn build_ix<A, I>(accounts: &A, args: &I) -> Instruction
where
    A: ToAccountMetas,
    I: InstructionData,
{
    Instruction::new_with_bytes(
        stocksie::id(),
        &args.data(),
        accounts.to_account_metas(None),
    )
}

/// Sign + submit a single-instruction transaction as `payer`, returning the
/// raw LiteSVM `TransactionResult` for the caller to assert on (success path)
/// or pass to [`assert_error_code`] (failure path).
///
/// `TransactionResult`'s `Err` variant (`FailedTransactionMetadata`) is >200
/// bytes because it embeds the full `TransactionMetadata` (logs, inner
/// instructions, return data). This is LiteSVM's native return type — we
/// cannot shrink it, and boxing it would merely add indirection for a value
/// that is consumed immediately by assertions. Suppress the lint locally.
#[allow(clippy::result_large_err)]
pub fn send(svm: &mut LiteSVM, payer: &Keypair, ix: Instruction) -> TransactionResult {
    let blockhash = svm.latest_blockhash();
    let msg = Message::new_with_blockhash(&[ix], Some(&payer.pubkey()), &blockhash);
    let tx = Transaction::new(&[payer], msg, blockhash);
    svm.send_transaction(tx)
}

// ---------------------------------------------------------------------------
// State assertions
// ---------------------------------------------------------------------------

/// Deserialize an Anchor account from the SVM, verifying its discriminator.
///
/// Returns `None` if the account does not exist or its 8-byte discriminator
/// does not match `T` (e.g. asking for a `Household` read on a `Member` PDA),
/// which guards tests against silent cross-type mix-ups.
pub fn account_of<T: AccountDeserialize>(svm: &LiteSVM, pubkey: &Pubkey) -> Option<T> {
    let account = svm.get_account(pubkey)?;
    let mut data: &[u8] = &account.data;
    T::try_deserialize(&mut data).ok()
}

/// Lamport balance of `pubkey`, or `0` if the account does not exist.
///
/// Convenience wrapper over `LiteSVM::get_balance` for vault-solvency and
/// rent-refund assertions where the expected delta is independent of the
/// account's existence.
pub fn balance_of(svm: &LiteSVM, pubkey: &Pubkey) -> u64 {
    svm.get_balance(pubkey).unwrap_or(0)
}

// ---------------------------------------------------------------------------
// Event assertions
// ---------------------------------------------------------------------------

/// Decode every `Program data: <base64>` log into events of type `E`.
///
/// Anchor events are emitted via `sol_log_data` as `discriminator(8) ++
/// borsh(fields)` (see `anchor-attribute-event-1.0.2/src/lib.rs`: the `#[event]`
/// macro derives `AnchorSerialize`, `AnchorDeserialize`, `Discriminator`, and
/// `Event::data()`). We filter by `E::DISCRIMINATOR` so a single transaction's
/// mixed event stream can be queried per-type without cross-talk.
///
/// Works on both successful and failed results — failed transactions still
/// emit events up to the failure point, useful for negative tests asserting a
/// partial event sequence before the error.
pub fn emitted_events_of<E>(result: &TransactionResult) -> Vec<E>
where
    E: Event + Discriminator + AnchorDeserialize,
{
    let logs = match result {
        Ok(meta) => &meta.logs,
        Err(failed) => &failed.meta.logs,
    };
    let disc_len = E::DISCRIMINATOR.len();
    logs.iter()
        .filter_map(|line| line.strip_prefix("Program data: "))
        .filter_map(|b64| base64::engine::general_purpose::STANDARD.decode(b64).ok())
        .filter(|bytes| bytes.starts_with(E::DISCRIMINATOR))
        .filter_map(|bytes| E::try_from_slice(&bytes[disc_len..]).ok())
        .collect()
}

// ---------------------------------------------------------------------------
// Error assertions
// ---------------------------------------------------------------------------

/// Assert that a failed transaction reverted with the specific Stocksie error
/// code matching `expected`.
///
/// Anchor's `#[error_code]` maps each variant to `discriminant +
/// ERROR_CODE_OFFSET (6000)` (see `anchor-lang-1.0.2/src/error.rs`), surfaced
/// on-chain as `InstructionError::Custom(n)`. Asserting the exact `n` — rather
/// than just `.is_err()` — proves the *right* guard fired; a generic failure
/// could mask an unrelated bug.
///
/// On mismatch the panic embeds `meta.pretty_logs()` so the full instruction
/// trace is visible without re-running the test.
///
/// Reserved for Phase 8 (negative / permission tests); not exercised by the
/// Phase 7 household smoke tests, hence the explicit `#[allow(dead_code)]`
/// rather than letting the warning fire until the permissions target lands.
pub fn assert_error_code(failed: FailedTransactionMetadata, expected: StocksieError) {
    let want = u32::from(expected);
    match &failed.err {
        TransactionError::InstructionError(_, InstructionError::Custom(got)) => {
            assert_eq!(
                *got,
                want,
                "wrong error code; logs:\n{}",
                failed.meta.pretty_logs()
            );
        }
        other => panic!(
            "expected InstructionError::Custom({want}); got {other:?}; logs:\n{}",
            failed.meta.pretty_logs()
        ),
    }
}

// ---------------------------------------------------------------------------
// Scenario helpers — multi-step setups shared across lifecycle / permission /
// reimburse / rewards tests. Each drives a real instruction sequence through
// LiteSVM and panics on any precondition failure (a broken setup is a test
// bug, not a soft error).
// ---------------------------------------------------------------------------

/// Add an arbitrary member to an existing household under `role`. Returns the
/// new member's PDA. The new wallet is **not** funded — callers that need the
/// new member to sign (e.g. as a buyer or a forbidden caller) must airdrop it.
pub fn add_member(
    svm: &mut LiteSVM,
    owner: &Keypair,
    household_pda: Pubkey,
    owner_member_pda: Pubkey,
    new_member_wallet: Pubkey,
    role: Role,
) -> Pubkey {
    let (new_member_pda, _) = derive_member(&household_pda, &new_member_wallet);
    let ix = build_ix(
        &stocksie::accounts::AddMember {
            household: household_pda,
            caller_member: owner_member_pda,
            new_member: new_member_pda,
            caller: owner.pubkey(),
            system_program: SYSTEM_PROGRAM_ID,
        },
        &stocksie::instruction::AddMember {
            new_member_wallet,
            role,
        },
    );
    let result = send(svm, owner, ix);
    assert!(
        result.is_ok(),
        "add_member failed:\n{}",
        result.as_ref().unwrap_err().meta.pretty_logs()
    );
    new_member_pda
}

/// Set up a two-member household (Owner + Parent) funded with
/// `DEPOSIT_LAMPORTS` in the vault. The Parent is funded with 10 SOL so they
/// can sign `confirm_restock` later (the buyer must be the payer/signer of
/// that instruction).
///
/// Returns `(parent_kp, household_pda, owner_member_pda, parent_member_pda)`.
pub fn setup_two_member_household(
    svm: &mut LiteSVM,
    owner: &Keypair,
) -> (Keypair, Pubkey, Pubkey, Pubkey) {
    let owner_pk = owner.pubkey();
    let (household_pda, _) = derive_household(&owner_pk);
    let (owner_member_pda, _) = derive_member(&household_pda, &owner_pk);

    // 1. initialize_household — owner is the first member (role = Owner).
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
    let init_result = send(svm, owner, init_ix);
    assert!(
        init_result.is_ok(),
        "initialize_household failed:\n{}",
        init_result.as_ref().unwrap_err().meta.pretty_logs()
    );

    // 2. add Parent member — they will be the buyer in the lifecycle.
    let parent = Keypair::new();
    let parent_pk = parent.pubkey();
    svm.airdrop(&parent_pk, 10_000_000_000)
        .expect("airdrop of parent funds failed");
    let parent_member_pda = add_member(
        svm,
        owner,
        household_pda,
        owner_member_pda,
        parent_pk,
        Role::Parent,
    );

    // 3. deposit_funds — fund the vault so reimbursement is solvent.
    let deposit_ix = build_ix(
        &stocksie::accounts::DepositFunds {
            household: household_pda,
            depositor_member: owner_member_pda,
            depositor: owner_pk,
            system_program: SYSTEM_PROGRAM_ID,
        },
        &stocksie::instruction::DepositFunds {
            lamports: DEPOSIT_LAMPORTS,
        },
    );
    let deposit_result = send(svm, owner, deposit_ix);
    assert!(
        deposit_result.is_ok(),
        "deposit_funds failed:\n{}",
        deposit_result.as_ref().unwrap_err().meta.pretty_logs()
    );

    (parent, household_pda, owner_member_pda, parent_member_pda)
}

/// Drive a request through `Pending → Approved → Restocked` and return the
/// request PDA. The owner is the reporter/approver; the buyer must be a real,
/// active, transacting member of the household (signs `confirm_restock`).
pub fn reach_restocked(
    svm: &mut LiteSVM,
    owner: &Keypair,
    buyer: &Keypair,
    household_pda: Pubkey,
    owner_member_pda: Pubkey,
    buyer_member_pda: Pubkey,
) -> Pubkey {
    // create_purchase_request — reporter = owner, buyer = `buyer`.
    // `request_id = household.request_counter + 1` = 1 (counter starts at 0).
    let (request_pda, _) = derive_request(&household_pda, 1);

    let create_ix = build_ix(
        &stocksie::accounts::CreatePurchaseRequest {
            household: household_pda,
            caller_member: owner_member_pda,
            request: request_pda,
            buyer_member: buyer_member_pda,
            caller: owner.pubkey(),
            system_program: SYSTEM_PROGRAM_ID,
        },
        &stocksie::instruction::CreatePurchaseRequest {
            amount_lamports: REQUEST_AMOUNT_LAMPORTS,
            item_hash: ITEM_HASH,
            unit_cost_hash: UNIT_COST_HASH,
            buyer: buyer.pubkey(),
        },
    );
    let create_result = send(svm, owner, create_ix);
    assert!(
        create_result.is_ok(),
        "create_purchase_request failed:\n{}",
        create_result.as_ref().unwrap_err().meta.pretty_logs()
    );

    // approve_purchase_request — caller = owner (approver ≠ buyer).
    let approve_ix = build_ix(
        &stocksie::accounts::ApprovePurchaseRequest {
            household: household_pda,
            caller_member: owner_member_pda,
            request: request_pda,
            caller: owner.pubkey(),
        },
        &stocksie::instruction::ApprovePurchaseRequest {},
    );
    let approve_result = send(svm, owner, approve_ix);
    assert!(
        approve_result.is_ok(),
        "approve_purchase_request failed:\n{}",
        approve_result.as_ref().unwrap_err().meta.pretty_logs()
    );

    // confirm_restock — buyer signs and is the tx payer.
    let confirm_ix = build_ix(
        &stocksie::accounts::ConfirmRestock {
            household: household_pda,
            buyer_member: buyer_member_pda,
            request: request_pda,
            buyer: buyer.pubkey(),
        },
        &stocksie::instruction::ConfirmRestock {
            unit_cost_hash: UNIT_COST_HASH,
        },
    );
    let confirm_result = send(svm, buyer, confirm_ix);
    assert!(
        confirm_result.is_ok(),
        "confirm_restock failed:\n{}",
        confirm_result.as_ref().unwrap_err().meta.pretty_logs()
    );

    request_pda
}

/// Drive a request through the full lifecycle `Pending → Reimbursed` and
/// return the request PDA. Composes [`reach_restocked`] + a `reimburse_buyer`
/// paying out `REIMBURSE_LAMPORTS` (≤ the approved ceiling).
pub fn reach_reimbursed(
    svm: &mut LiteSVM,
    owner: &Keypair,
    buyer: &Keypair,
    household_pda: Pubkey,
    owner_member_pda: Pubkey,
    buyer_member_pda: Pubkey,
) -> Pubkey {
    let request_pda = reach_restocked(
        svm,
        owner,
        buyer,
        household_pda,
        owner_member_pda,
        buyer_member_pda,
    );

    let reimburse_ix = build_ix(
        &stocksie::accounts::ReimburseBuyer {
            household: household_pda,
            caller_member: owner_member_pda,
            request: request_pda,
            buyer_member: buyer_member_pda,
            buyer: buyer.pubkey(),
            caller: owner.pubkey(),
        },
        &stocksie::instruction::ReimburseBuyer {
            lamports: REIMBURSE_LAMPORTS,
        },
    );
    let reimburse_result = send(svm, owner, reimburse_ix);
    assert!(
        reimburse_result.is_ok(),
        "reimburse_buyer failed:\n{}",
        reimburse_result.as_ref().unwrap_err().meta.pretty_logs()
    );

    request_pda
}
