# Stocksie — Testing Plan

> LiteSVM-first: every behavior, permission, and security invariant is asserted in-process, in milliseconds, with no cluster.

This document is the source the `programs/stocksie/tests/` files implement against. Every invariant in `03_account_model.md`, every transition in `05_state_machine.md`, every event in `06_events.md`, and every defense in `07_security.md` is asserted by a named test below. If a behavior isn't tested here, it isn't shipped.

---

## 1. Testing pyramid

```text
                  ┌─────────────────────────┐
                  │   Cluster smoke tests   │   ← devnet/testnet, optional, post-MVP
                  └─────────────────────────┘
                ┌───────────────────────────────┐
                │   Integration (Surfpool)      │   ← mainnet-fork realism, post-MVP
                └───────────────────────────────┘
              ┌─────────────────────────────────────┐
              │   LiteSVM (in-process Rust VM)      │   ← THE MVP LAYER
              └─────────────────────────────────────┘
            ┌──────────────────────────────────────────┐
            │   Pure unit tests (state machines, types)│   ← no VM, instant
            └──────────────────────────────────────────┘
```

For the MVP we live almost entirely in the bottom two layers:

- **Pure unit tests** (`#[cfg(test)]` blocks inside `src/`) verify domain logic that doesn't need accounts: the `Status` state machine, `Role::can_*()` helpers, `Household::next_request_id`, `Member::add_reward`, `PurchaseRequest::transition_*`. These run in microseconds and give the tightest feedback loop.
- **LiteSVM tests** (`programs/stocksie/tests/*.rs`) verify the full instruction surface against the real compiled `.so`: account creation, PDA derivation, constraint failures, CPI transfers, event emission, and balance deltas.

Surfpool and cluster tests are deferred (see `09_build_phases.md`); they're valuable for mainnet-fork realism but unnecessary to prove the MVP correct.

---

## 2. LiteSVM test harness pattern

Every LiteSVM test file shares the same harness shape, extracted into `tests/helpers/mod.rs`:

```rust
// tests/helpers/mod.rs (sketch)
pub fn setup_svm() -> (LiteSVM, Keypair) {
    let mut svm = LiteSVM::new();
    let program_id = stocksie::id();
    let bytes = include_bytes!("../../../target/deploy/stocksie.so");
    svm.add_program(program_id, bytes).unwrap();
    let payer = Keypair::new();
    svm.airdrop(&payer.pubkey(), 100_000_000_000).unwrap(); // 100 SOL
    (svm, payer)
}

pub fn derive_household(owner: &Pubkey) -> (Pubkey, u8) {
    Pubkey::find_program_address(&[HOUSEHOLD_SEED, owner.as_ref()], &stocksie::id())
}

pub fn derive_member(household: &Pubkey, wallet: &Pubkey) -> (Pubkey, u8) {
    Pubkey::find_program_address(
        &[MEMBER_SEED, household.as_ref(), wallet.as_ref()],
        &stocksie::id(),
    )
}

pub fn derive_request(household: &Pubkey, request_id: u64) -> (Pubkey, u8) {
    Pubkey::find_program_address(
        &[PURCHASE_SEED, household.as_ref(), &request_id.to_le_bytes()],
        &stocksie::id(),
    )
}

pub fn send(svm: &mut LiteSVM, payer: &Keypair, ix: Instruction) -> TxResult {
    let blockhash = svm.latest_blockhash();
    let msg = Message::new_with_blockhash(&[ix], Some(&payer.pubkey()), &blockhash);
    let tx = VersionedTransaction::try_new(VersionedMessage::Legacy(msg), &[payer]).unwrap();
    svm.send_transaction(tx)
}
```

Each test composes instructions using the Anchor-generated client surface:

```rust
let accounts = stocksie::accounts::InitializeHousehold { household, owner_member, owner: owner.pubkey(), system_program: system_program::ID };
let ix = Instruction::new_with_bytes(
    stocksie::id(),
    &stocksie::instruction::InitializeHousehold { name_hash: [1u8; 32] }.data(),
    &accounts.to_account_metas(None),
);
```

This keeps tests close to how a real client builds transactions and exercises the actual IDL-generated encoders.

---

## 3. Test matrix

Every row below is a named test. The "Layer" column is `U` (pure unit), `L` (LiteSVM), or `B` (both). The "Plan ref" column links back to the invariant's source.

### 3.1 State machine & types (pure unit)

| Test | Asserts | Layer | Plan ref |
| --- | --- | :---: | --- |
| `role_permissions_are_sensible` | `Owner` can manage members; `Parent` can approve/award; `Child` can transact only; `Guest` cannot transact | U | `01_concept.md` §3 |
| `status_terminal_and_labels` | `Reimbursed`/`Rejected` are terminal; labels are stable strings | U | `05_state_machine.md` §1 |
| `next_request_id_is_monotonic_starting_at_one` | First id is `1`, increments are monotonic | U | `05_state_machine.md` §6 |
| `happy_path_lifecycle` | `Pending → Approved → Restocked → Reimbursed` succeeds and sets slots | U | `05_state_machine.md` §2 |
| `cannot_skip_approval` | `confirm_restock`/`reimburse_buyer` from `Pending` fail | U | `05_state_machine.md` §4 |
| `cannot_reimburse_more_than_approved` | Over-ceiling reimbursement returns `ReimbursementExceedsApproved` | U | `05_state_machine.md` §4 |
| `cannot_reimburse_twice` | Second reimbursement returns `AlreadyReimbursed` | U | `05_state_machine.md` §4 |
| `reject_works_from_pending_or_approved` | Rejection succeeds from both allowed states | U | `05_state_machine.md` §2 |
| `cannot_reject_after_restock` | Rejection from `Restocked` fails | U | `05_state_machine.md` §4 |
| `record_reward_stage_accumulates` | `reward_earned` accumulates without overflow | U | `06_events.md` §5 |
| `add_reward_accumulates_and_rejects_zero` | `Member::add_reward(0)` returns `ZeroReward` | U | `03_account_model.md` §3 |
| `inactive_members_cannot_transact_or_approve_regardless_of_role` | `active=false` zeroes all gates | U | `07_security.md` §3.7 |
| `deactivate_then_reactivate_round_trip` | Soft-delete preserves `role` and `reward_points` | U | `03_account_model.md` §3 |

### 3.2 Household lifecycle (LiteSVM)

| Test | Asserts | Layer | Plan ref |
| --- | --- | :---: | --- |
| `initialize_household_creates_pdas` | `Household` + owner `Member` exist with correct fields | L | `04_instructions.md` §1.1 |
| `initialize_household_emits_two_events` | `HouseholdCreated` + `MemberAdded` (role `Owner`) appear in logs | L | `06_events.md` §4 |
| `add_member_increments_count` | `member_count` goes 1 → 2; new `Member` has the supplied role | L | `04_instructions.md` §1.2 |
| `add_member_owner_role_rejected` | `role == Owner` returns `CannotModifyOwner` | L | `04_instructions.md` §1.2 |
| `add_member_duplicate_rejected` | Re-adding an existing wallet fails on PDA collision | L | `07_security.md` §2.4 |
| `add_member_cap_enforced` | After `MAX_MEMBERS`, returns `MemberLimitReached` | L | `03_account_model.md` |
| `remove_member_decrements_and_refunds_rent` | `member_count` decreases; caller's balance increases by rent | L | `04_instructions.md` §1.3 |
| `remove_member_owner_rejected` | Removing the owner returns `CannotModifyOwner` | L | `07_security.md` §3.6 |
| `remove_member_then_readd_succeeds` | After close, a fresh `init` re-onboards cleanly | L | `07_security.md` §8 |
| `set_role_changes_role_and_emits` | `target.role` flips; `RoleChanged` event carries both roles | L | `04_instructions.md` §1.4 |
| `set_role_to_owner_rejected` | Promoting to `Owner` returns `CannotModifyOwner` | L | `07_security.md` §3.6 |

### 3.3 Vault / funds (LiteSVM)

| Test | Asserts | Layer | Plan ref |
| --- | --- | :---: | --- |
| `deposit_funds_credits_vault` | Vault lamports and `vault_balance` both increase; `FundsDeposited` carries the snapshot | L | `04_instructions.md` §2.1 |
| `deposit_funds_zero_rejected` | `lamports == 0` returns `ZeroDeposit` | L | `04_instructions.md` §2.1 |
| `deposit_funds_by_guest_succeeds` | A `Guest` member may deposit (external support flow) | L | `04_instructions.md` §2.1 |
| `deposit_funds_by_non_member_rejected` | A wallet with no `Member` PDA fails the seed constraint | L | `07_security.md` §2.9 |
| `withdraw_funds_owner_only` | `Parent` caller returns `UnauthorizedRole`; owner succeeds | L | `04_instructions.md` §2.2 |
| `withdraw_funds_debits_vault` | Vault lamports and `vault_balance` both decrease by exactly `lamports` | L | `04_instructions.md` §2.2 |
| `withdraw_funds_insufficient_rejected` | `lamports > vault_balance` returns `InsufficientVaultFunds` | L | `07_security.md` §3.1 |
| `withdraw_funds_routes_to_owner_only` | A different destination returns `NotOwner` (defense-in-depth) | L | `04_instructions.md` §2.2 |

### 3.4 Purchase lifecycle — happy path (LiteSVM)

| Test | Asserts | Layer | Plan ref |
| --- | --- | :---: | --- |
| `full_lifecycle_reaches_reimbursed` | `create → approve → confirm → reimburse` walks the full machine | L | `01_concept.md` §5 |
| `create_purchase_request_assigns_monotonic_id` | First request id is `1`; second is `2` | L | `05_state_machine.md` §6 |
| `create_purchase_request_rewards_reporter` | Caller's `reward_points += REWARD_LOW_STOCK_REPORT` | L | `06_events.md` §5 |
| `create_purchase_request_range_checks_amount` | Below-min and above-max both rejected | L | `04_instructions.md` §3.1 |
| `approve_sets_approver_and_slot` | `approved_by == caller`, `approved_slot > 0` | L | `05_state_machine.md` §3 |
| `confirm_restock_rewards_buyer` | Buyer's `reward_points += REWARD_RESTOCK_COMPLETED` | L | `06_events.md` §5 |
| `confirm_restock_overwrites_unit_cost_hash` | The actual-purchase hash is recorded | L | `04_instructions.md` §3.4 |
| `reimburse_pays_buyer_exact_lamports` | Buyer's balance increases by `lamports`; vault decreases by `lamports` | L | `04_instructions.md` §4.1 |
| `reimburse_under_ceiling_allowed` | `lamports < amount_lamports` succeeds; delta stays in vault | L | `04_instructions.md` §8 |
| `reimburse_rewards_full_run` | Buyer's `reward_points += REWARD_FULL_RUN_COMPLETED` | L | `06_events.md` §5 |
| `close_purchase_request_refunds_rent` | Terminal request closure refunds caller | L | `04_instructions.md` §3.5 |

### 3.5 Purchase lifecycle — permission & negative (LiteSVM)

| Test | Asserts | Layer | Plan ref |
| --- | --- | :---: | --- |
| `child_cannot_approve` | A `Child` approver returns `UnauthorizedRole` | L | `07_security.md` §3.4 |
| `guest_cannot_create_request` | A `Guest` reporter returns `UnauthorizedRole` | L | `04_instructions.md` §3.1 |
| `self_approval_rejected` | Approver == buyer returns `SelfApprovalForbidden` | L | `07_security.md` §3.4 |
| `non_buyer_cannot_confirm_restock` | A wallet ≠ `request.buyer` returns `NotBuyer` | L | `07_security.md` §3.5 |
| `confirm_restock_before_approval_rejected` | Returns `InvalidStatusTransition` | L | `05_state_machine.md` §4 |
| `reimburse_before_restock_rejected` | Returns `InvalidStatusTransition` | L | `05_state_machine.md` §4 |
| `reimburse_zero_lamports_rejected` | Returns `ZeroWithdrawal` | L | `05_state_machine.md` §4 |
| `reimburse_over_ceiling_rejected` | Returns `ReimbursementExceedsApproved` | L | `07_security.md` §3.3 |
| `double_reimbursement_rejected` | Second call returns `AlreadyReimbursed` | L | `07_security.md` §3.2 |
| `reject_from_restocked_rejected` | Returns `InvalidStatusTransition` | L | `05_state_machine.md` §4 |
| `close_non_terminal_rejected` | Closing a `Pending`/`Approved`/`Restocked` request fails | L | `04_instructions.md` §3.5 |
| `close_by_non_authority_rejected` | A random non-buyer, non-owner member cannot close | L | `04_instructions.md` §3.5 |
| `insufficient_vault_does_not_advance_state` | Reimbursement with empty vault leaves the request in `Restocked` | L | `07_security.md` §3.1 |

### 3.6 Rewards (LiteSVM)

| Test | Asserts | Layer | Plan ref |
| --- | --- | :---: | --- |
| `award_reward_credits_target` | `target_member.reward_points += points`; household total also bumps | L | `04_instructions.md` §5.1 |
| `award_reward_child_caller_rejected` | `Child` awarder returns `UnauthorizedRole` | L | `04_instructions.md` §5.1 |
| `award_reward_zero_rejected` | `points == 0` returns `ZeroReward` | L | `04_instructions.md` §5.1 |
| `reward_summary_emits_sentinel` | `RewardEarned` with `points == 0` and current `total_points` is emitted | L | `06_events.md` §3.4 |
| `reward_reconciliation_sum_matches_account` | Sum of `RewardEarned.points > 0` equals `Member.reward_points` | L | `06_events.md` §5 |

### 3.7 Security (LiteSVM)

| Test | Asserts | Layer | Plan ref |
| --- | --- | :---: | --- |
| `fake_account_rejected` | A bogus account with the right discriminator is rejected (owner check) | L | `07_security.md` §2.1 |
| `unsigned_call_rejected` | A call with no signer signature fails | L | `07_security.md` §2.2 |
| `double_init_rejected` | Re-running `initialize_household` for the same owner fails | L | `07_security.md` §2.4 |
| `cross_household_isolation` | A `Member` from family A cannot transact in family B | L | `07_security.md` §2.5 |
| `type_cosplay_rejected` | Passing a `Member` where a `Household` is expected fails | L | `07_security.md` §2.6 |
| `aliased_vault_debit_rejected` | `debit_vault` with `vault == to` returns `HouseholdAccountMismatch` | L | `07_security.md` §2.7 |
| `close_then_revive_rejected` | Reviving a closed account with stale data fails | L | `07_security.md` §2.8 |
| `cross_household_has_one_rejected` | A mismatched `household` back-reference fails `has_one` | L | `07_security.md` §2.9 |
| `canonical_bump_stored` | Every PDA's `bump` field equals `find_program_address`'s canonical | L | `07_security.md` §2.10 |
| `prefunded_pda_init_rejected` | Pre-funding a PDA at our seeds makes `init` fail | L | `07_security.md` §2.11 |
| `overflow_returns_error` | Saturating a `u64` counter returns `Overflow`/`RewardOverflow` | L | `07_security.md` §4 |
| `cross_household_account_rejected` | Reimbursing request A with household B's vault fails | L | `07_security.md` §6 |

### 3.8 Invariants (cross-cutting)

| Test | Asserts | Layer | Plan ref |
| --- | --- | :---: | --- |
| `treasury_reconciliation` | deposits − withdrawals − reimbursements == `vault_balance` at any slot | L | `06_events.md` §5 |
| `reward_reconciliation_household_total` | `sum(RewardEarned.points > 0) == household.total_rewards_distributed` | L | `06_events.md` §5 |
| `membership_reconciliation` | `MemberAdded` minus `MemberRemoved` == current set of `Member` PDAs | L | `06_events.md` §5 |
| `no_self_approval_in_event_stream` | For every `PurchaseApproved`, `approver != buyer` | L | `06_events.md` §5 |
| `lifecycle_monotonicity` | For any request, the event sequence is well-formed and slot-ordered | L | `06_events.md` §5 |

### 3.9 Privacy & space budget (special)

| Test | Asserts | Layer | Plan ref |
| --- | --- | :---: | --- |
| `no_string_fields_on_chain` | No `#[account]` or `#[event]` struct contains a `String` field (source grep) | U | `03_account_model.md` §6 |
| `test_space_budget` | `Household::INIT_SPACE == 101`, `Member::INIT_SPACE == 83`, `PurchaseRequest::INIT_SPACE == 226` | U | `03_account_model.md` §5 |

---

## 4. Test file layout

```text
programs/stocksie/
├── src/                                  # pure unit tests live inline under #[cfg(test)]
│   ├── types.rs                          #   role_permissions_*, status_terminal_*
│   ├── state/
│   │   ├── household.rs                  #   next_request_id_*, record_rewards_*
│   │   ├── member.rs                     #   add_reward_*, inactive_members_*, deactivate_*
│   │   └── purchase_request.rs           #   happy_path_lifecycle, cannot_*_rejected, etc.
│   └── instructions/*.rs                 #   per-instruction permission sanity (Owner-only, etc.)
│
└── tests/                                # LiteSVM integration tests (separate test targets)
    ├── helpers/
    │   └── mod.rs                        # shared harness: setup_svm, derive_*, send
    ├── test_household.rs                 #   §3.2 — init, add/remove, set_role
    ├── test_funds.rs                     #   §3.3 — deposit/withdraw, vault solvency
    ├── test_lifecycle.rs                 #   §3.4 — full happy path + reconciliation
    ├── test_permissions.rs               #   §3.5 — role gates, self-approval, non-buyer
    ├── test_reimburse.rs                 #   §3.5 — over-ceiling, zero, double, insufficient
    ├── test_rewards.rs                   #   §3.6 — award_reward, reward_summary, reconciliation
    ├── test_security.rs                  #   §3.7 — owner/signer/PDA/close/revival defenses
    ├── test_state_machine.rs             #   §3.1 (re-exported, also runs as pure unit)
    ├── test_invariants.rs                #   §3.8 — treasury, reward, membership, monotonicity
    ├── test_privacy_invariant.rs         #   §3.9 — no String fields (source grep)
    └── test_space.rs                     #   §3.9 — INIT_SPACE assertions
```

### Layout rules

- **Pure unit tests live inline.** State-machine and permission-helper tests are `#[cfg(test)] mod tests` inside the source file they exercise. They run without `target/deploy/stocksie.so`, so they execute even before the first `anchor build`.
- **LiteSVM tests are separate targets.** Each `tests/test_*.rs` is a Cargo integration test that includes the compiled `.so` via `include_bytes!`. They depend on a successful `anchor build` having produced `target/deploy/stocksie.so`.
- **Shared harness in `tests/helpers/mod.rs`.** The `setup_svm`, `derive_*`, and `send` helpers are the single place that knows how to talk to LiteSVM. Test bodies stay declarative.

---

## 5. LiteSVM features used

| Feature | Where | Why |
| --- | --- | --- |
| `svm.add_program(id, bytes)` | `setup_svm` | Load the compiled program once per test |
| `svm.airdrop(&pubkey, lamports)` | `setup_svm` | Fund the payer (and, where needed, the vault) |
| `svm.latest_blockhash()` | `send` | Fresh blockhash per transaction |
| `svm.send_transaction(tx)` | `send` | Execute and collect the result |
| `svm.simulate_transaction(tx)` | `test_lifecycle` | Pre-flight the happy path; assert sim result matches exec result |
| `svm.get_account(&pubkey)` | most tests | Read back account state for assertions |
| `result.unwrap_err()` | negative tests | Assert the instruction failed (and inspect the error code) |
| `meta.logs` | event tests | Inspect the emitted event stream |

We deliberately avoid time-travel (`warp_to_slot`) and sysvar overrides in the MVP — no instruction depends on elapsed time. If a future feature needs slot-based logic, `svm.warp_to_slot` is the hook.

---

## 6. Negative-test pattern

Negative tests follow a fixed shape to keep assertions tight:

```rust
#[test]
fn child_cannot_approve() {
    let (mut svm, owner) = setup_svm();
    let (household, parent, child, request) = setup_household_with_pending_request(&mut svm, &owner);

    // Parent's approval succeeds (control case).
    let approve_ix = build_approve_ix(&household, &request, &parent);
    assert!(send(&mut svm, &parent, approve_ix).is_ok());

    // Reset state with a fresh request submitted by the child, then attempt
    // approval as the child — must fail with UnauthorizedRole.
    let request2 = create_request_as(&mut svm, &child, /*buyer=*/ &parent);
    let approve_ix = build_approve_ix(&household, &request2, &child);
    let err = send(&mut svm, &child, approve_ix).unwrap_err();
    assert_error_code(err, StocksieError::UnauthorizedRole);
}
```

Every negative test:

1. **Establishes the positive control** (a valid call succeeds) to prove the failure is about *authorization*, not a broken instruction.
2. **Mutates exactly one variable** (caller role, status, amount, account).
3. **Asserts the specific error code**, not just `.is_err()`. A generic failure could mask an unrelated bug; the specific code proves the right guard fired.

---

## 7. Event assertion pattern

LiteSVM returns the transaction's logs in `meta.logs`. Anchor events are emitted as base64-encoded borsh under a `Program data:` log line. The harness decodes them:

```rust
fn emitted_events(result: &TxResult) -> Vec<Event> {
    result.meta.logs.iter()
        .filter_map(|line| line.strip_prefix("Program data: "))
        .filter_map(|b64| base64::decode(b64).ok())
        .filter_map(|bytes| Event::try_from_bytes(&bytes).ok())
        .collect()
}
```

Each event test asserts both the **count** (e.g. "exactly two events") and the **shape** (e.g. "the first is `HouseholdCreated` with `owner == X`"). This catches both missing and malformed emissions.

---

## 8. CI integration

The MVP CI pipeline (GitHub Actions or equivalent) is intentionally minimal because LiteSVM needs no cluster:

```yaml
jobs:
  unit-and-litesvm:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions-rust-toolchain/install@v1
        with: { toolchain: '1.89.0', components: 'clippy,rustfmt' }
      - name: Install Anchor 1.0.2
        run: cargo install --git https://github.com/solana-foundation/anchor --tag v1.0.2 anchor-cli --locked
      - name: Build (.so + IDL)
        run: anchor build
      - name: Pure unit tests
        run: cargo test -p stocksie --lib
      - name: LiteSVM integration tests
        run: cargo test -p stocksie --tests
      - name: Lint
        run: cargo clippy --all-targets -- -D warnings
      - name: Format check
        run: cargo fmt --all -- --check
```

The `anchor build` step is a hard prerequisite for the LiteSVM tests because they `include_bytes!` the `.so`.

---

## 9. Test data fixtures

Tests use **deterministic, generated** keypairs rather than hardcoded keys, so they're reproducible without secrets:

```rust
let owner = Keypair::new();      // ephemeral, random per test run
let parent = Keypair::new();
let child = Keypair::new();
```

Where a test needs to assert against a *specific* value (e.g. a `name_hash`), it uses a recognizable constant:

```rust
const NAME_HASH: [u8; 32] = [0xAA; 32];   // recognizable in test output
const ITEM_HASH: [u8; 32] = [0xBB; 32];
```

No fixture files, no network calls, no mainnet cloning — every test is self-contained.

---

## 10. Coverage targets

The MVP doesn't ship without:

- **100% of instructions** having at least one positive and one negative LiteSVM test.
- **Every `StocksieError` variant** being asserted as the return value of at least one test.
- **Every state-machine transition** (T1–T5 in `05_state_machine.md`) having a happy-path test.
- **Every forbidden transition** in `05_state_machine.md` §4 having a negative test.
- **Every security item** in `07_security.md` §2 having a named test.
- **The privacy invariant** (`no_string_fields_on_chain`) green.
- **The space budget** (`test_space_budget`) green and matching `03_account_model.md` §5.

`cargo test` run time target: **under 10 seconds wall-clock** for the full suite, since LiteSVM is in-process. If the suite drifts past that, the culprit is usually a redundant `anchor build` in a hot path.

---

## Next up

- **`plan/09_build_phases.md`** — the phased build order with status tracking: which files land in which phase, in what order, and how to verify each phase before moving on. Then **`plan/10_docs.md`** (user-facing and developer docs to produce) finishes the plan folder before we resume implementation in `programs/stocksie/src/instructions/funds.rs`.