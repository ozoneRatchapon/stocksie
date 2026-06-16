# Stocksie — Build Phases & Status

> The phased build order for the MVP. Each phase has a clear definition of done, the files it touches, and a verification step. Status is tracked inline so anyone can see where we are at a glance.

This is the operational counterpart to the design docs (`01`–`08`). Plan files lead; this file tracks execution. Update the status markers (`[ ]` / `[x]` / `[~]` in-progress) as work lands.

**Status legend**: `[ ]` not started · `[~]` in progress · `[x]` done · `[!]` blocked

---

## Phase map (at a glance)

| Phase | Surface | Status | Files |
| --- | --- | :---: | --- |
| 0 | Scaffold + toolchain | `[x]` | `Anchor.toml`, `Cargo.toml`, `target` symlink |
| 1 | Plan folder | `[~]` | `plan/01..10_*.md` |
| 2 | Foundation | `[x]` | `constants.rs`, `error.rs`, `events.rs`, `types.rs` |
| 3 | State layer | `[x]` | `state/{household,member,purchase_request,mod}.rs` |
| 4a | Instructions — household | `[x]` | `instructions/household.rs` |
| 4b | Instructions — funds | `[ ]` | `instructions/funds.rs` |
| 4c | Instructions — purchase | `[ ]` | `instructions/purchase.rs` |
| 4d | Instructions — reimburse | `[ ]` | `instructions/reimburse.rs` |
| 4e | Instructions — rewards | `[ ]` | `instructions/rewards.rs` |
| 4f | Instructions index | `[ ]` | `instructions/mod.rs` |
| 5 | `lib.rs` dispatch wiring | `[ ]` | `lib.rs` |
| 6 | First clean build | `[ ]` | `target/deploy/stocksie.so`, `target/idl/stocksie.json` |
| 7 | LiteSVM harness + smoke | `[ ]` | `tests/helpers/mod.rs`, `tests/test_household.rs` |
| 8 | Lifecycle + permission tests | `[ ]` | `tests/test_{lifecycle,permissions,reimburse,rewards}.rs` |
| 9 | Security + invariant tests | `[ ]` | `tests/test_{security,invariants,privacy_invariant,space}.rs` |
| 10 | Lint, clippy, fmt, autofixer | `[ ]` | whole crate |
| 11 | Docs (user + dev) | `[ ]` | `docs/{ARCHITECTURE,SECURITY,TESTING}.md`, `README.md` |
| 12 | Handover doc | `[ ]` | `.handovers/001_stocksie_mvp.md` |

**Current focus**: finish the plan folder (`Phase 1`), then resume at **Phase 4b** (`instructions/funds.rs`).

---

## Phase 0 — Scaffold + toolchain `[x]`

**Goal**: a clean Anchor 1.0.2 workspace that builds and whose trivial template test passes under LiteSVM.

**Done when**:
- `[x]` `anchor init stocksie --test-template litesvm` succeeds.
- `[x]` Project flattened to `/Users/ozone/stocksie` (no nested `stocksie/stocksie`).
- `[x]` `target/` symlinked to shared `~/.cargo/target` (machine-specific fix; see `02_architecture.md` §6).
- `[x]` Wrong-arch platform-tools cache purged (`~/.cache/solana/v1.52`) and re-downloaded arm64.
- `[x]` Program ID consistent across `lib.rs`, `Anchor.toml`, `target/deploy/stocksie-keypair.json` (`At2vd5Mqd9xcHRFAZin1VHb6upEsF1GCXoFG19UHsQoj`).
- `[x]` `anchor build` produces `target/deploy/stocksie.so` + `target/idl/stocksie.json`.
- `[x]` Template `test_initialize` passes.
- `[x]` Gitflow branches created: `develop` ← `develop/feature/01_household_program`.

**Verification**:
```sh
anchor build && cargo test -p stocksie
```
Both must succeed.

---

## Phase 1 — Plan folder `[~]`

**Goal**: the plan folder is the single source of truth; nothing gets implemented before its plan file exists.

**Files**:
- `[x]` `plan/README.md`
- `[x]` `plan/01_concept.md`
- `[x]` `plan/02_architecture.md`
- `[x]` `plan/03_account_model.md`
- `[x]` `plan/04_instructions.md`
- `[x]` `plan/05_state_machine.md`
- `[x]` `plan/06_events.md`
- `[x]` `plan/07_security.md`
- `[x]` `plan/08_testing.md`
- `[~]` `plan/09_build_phases.md` (this file)
- `[ ]` `plan/10_docs.md`

**Done when**: all 10 plan files exist and cross-reference each other consistently.

**Next up after this phase**: commit the plan folder, then start Phase 4b (`programs/stocksie/src/instructions/funds.rs`).

---

## Phase 2 — Foundation `[x]`

**Goal**: the cross-cutting types and constants every instruction depends on, with pure unit tests.

**Files**:
- `[x]` `programs/stocksie/src/constants.rs` — seeds, reward schedule, limits, `HASH_LEN`.
- `[x]` `programs/stocksie/src/error.rs` — `StocksieError` enum (membership, vault, lifecycle, reward, arithmetic).
- `[x]` `programs/stocksie/src/events.rs` — 11 `#[event]` structs, hashes-only payloads.
- `[x]` `programs/stocksie/src/types.rs` — `Role` + `Status` enums with `can_*()` / `is_*()` helpers.

**Done when**:
- `[x]` `Role::can_*()` and `Status::is_terminal()` / `.label()` have inline `#[cfg(test)]` coverage.
- `[x]` Every constant referenced in `03_account_model.md` and `04_instructions.md` is present.
- `[x]` No `String` fields anywhere (privacy invariant, asserted later by `tests/test_privacy_invariant.rs`).

**Verification**:
```sh
cargo test -p stocksie --lib types
cargo test -p stocksie --lib constants
```

---

## Phase 3 — State layer `[x]`

**Goal**: the three on-chain account structs with their domain methods, fully unit-tested in isolation.

**Files**:
- `[x]` `programs/stocksie/src/state/household.rs` — `Household` + `credit_vault` / `debit_vault` / `next_request_id` / `record_rewards`.
- `[x]` `programs/stocksie/src/state/member.rs` — `Member` + `add_reward` / `deactivate` / `reactivate` / `can_transact` / `can_approve`.
- `[x]` `programs/stocksie/src/state/purchase_request.rs` — `PurchaseRequest` + the five `transition_*` guards + `record_reward_stage`.
- `[x]` `programs/stocksie/src/state/mod.rs` — index only.

**Done when**:
- `[x]` Every `transition_*` method is covered by inline unit tests (happy path + every forbidden case from `05_state_machine.md` §4).
- `[x]` `debit_vault` has the anti-alias guard (`vault.key() == to.key()` → `HouseholdAccountMismatch`).
- `[x]` All arithmetic is checked (`checked_add` / `checked_sub` + `ok_or(Overflow|RewardOverflow)`).
- `[x]` `#[derive(InitSpace)]` is on every account; `INIT_SPACE` matches the budget in `03_account_model.md` §5.

**Verification**:
```sh
cargo test -p stocksie --lib state
```

---

## Phase 4a — Instructions: household `[x]`

**Goal**: the membership lifecycle (init, add, remove, set_role) compiles and is constraint-correct.

**Files**:
- `[x]` `programs/stocksie/src/instructions/household.rs` — `InitializeHousehold`, `AddMember`, `RemoveMember`, `SetRole` accounts + handlers.

**Done when**:
- `[x]` All four handlers are thin: constraints in the accounts struct, business rules in the handler.
- `[x]` Owner-only gates use `caller_member.role.can_manage_members()`.
- `[x]` `remove_member` uses `close = caller` (no `init_if_needed`).
- `[x]` Owner is irremovable and non-promotable (`role != Owner` constraints + handler-side `CannotModifyOwner`).
- `[x]` Events (`HouseholdCreated`, `MemberAdded`, `MemberRemoved`, `RoleChanged`) are emitted.

**Next up**: **Phase 4b** — `programs/stocksie/src/instructions/funds.rs`.

---

## Phase 4b — Instructions: funds `[ ]` ← RESUME HERE

**Goal**: the shared treasury in/out flows.

**Files**:
- `[ ]` `programs/stocksie/src/instructions/funds.rs` — `DepositFunds`, `WithdrawFunds` accounts + handlers.

**Spec**: `plan/04_instructions.md` §2.1 and §2.2.

**Implementation notes**:
- `DepositFunds`: requires `depositor_member` (active, any role incl. Guest). Calls `Household::credit_vault(depositor, household, system_program, lamports)` — that's a `system_program::transfer` CPI plus a checked `vault_balance += lamports`. Emits `FundsDeposited` with the post-credit `vault_balance`.
- `WithdrawFunds`: Owner-only (`caller_member.role.can_withdraw_funds()`). Defense-in-depth `household.owner == owner.key()`. Calls `Household::debit_vault(household, owner, lamports)`. Emits `FundsWithdrawn`. Reject `lamports == 0` with `ZeroWithdrawal`.

**Done when**:
- `[ ]` Both handlers compile against the `Household` methods from Phase 3.
- `[ ]` `deposit_funds` works for any active member (Guest included).
- `[ ]` `withdraw_funds` rejects non-owners with `UnauthorizedRole`.
- `[ ]` Events emitted match `06_events.md` §3.2.

**Verification**:
```sh
cargo build -p stocksie        # must compile cleanly
```
(LiteSVM tests come in Phase 7+.)

**Next up**: **Phase 4c** — `programs/stocksie/src/instructions/purchase.rs`.

---

## Phase 4c — Instructions: purchase lifecycle `[ ]`

**Goal**: the create/approve/reject/confirm/close surface.

**Files**:
- `[ ]` `programs/stocksie/src/instructions/purchase.rs` — `CreatePurchaseRequest`, `ApprovePurchaseRequest`, `RejectPurchaseRequest`, `ConfirmRestock`, `ClosePurchaseRequest`.

**Spec**: `plan/04_instructions.md` §3.1–§3.5. State machine: `plan/05_state_machine.md`.

**Implementation notes**:
- `CreatePurchaseRequest` computes `request_id = household.next_request_id()?` **before** the `request` PDA resolves. The seed is `[PURCHASE_SEED, household, &request_id.to_le_bytes()]`. Range-check `amount_lamports` against `MIN_REQUEST_LAMPORTS`/`MAX_REIMBURSEMENT_LAMPORTS`. Reward the reporter (`REWARD_LOW_STOCK_REPORT`) on caller, request, and household.
- `ApprovePurchaseRequest`: reject `caller == buyer` with `SelfApprovalForbidden`. Call `request.transition_approved(slot)?`. Set `approved_by`.
- `RejectPurchaseRequest`: `request.transition_rejected()?`. Carry `reason_hash`.
- `ConfirmRestock`: buyer-only (`request.buyer == caller.key()`). `request.transition_restocked(slot)?`. Overwrite `unit_cost_hash`. Reward buyer (`REWARD_RESTOCK_COMPLETED`).
- `ClosePurchaseRequest`: terminal-only; caller is buyer or Owner; `close = caller`.

**Done when**:
- `[ ]` All five handlers compile.
- `[ ]` State transitions go exclusively through `PurchaseRequest::transition_*` (no direct `status = ...`).
- `[ ]` Reporter/buyer rewards fire exactly once per stage.

**Next up**: **Phase 4d** — `programs/stocksie/src/instructions/reimburse.rs`.

---

## Phase 4d — Instructions: reimburse `[ ]`

**Goal**: the trust-critical vault → buyer SOL transfer.

**Files**:
- `[ ]` `programs/stocksie/src/instructions/reimburse.rs` — `ReimburseBuyer` accounts + handler.

**Spec**: `plan/04_instructions.md` §4.1. Security: `plan/07_security.md` §3.1–§3.3, §7.

**Implementation notes**:
- Caller is active Owner/Parent (`caller_member.can_approve()`).
- `request.transition_reimbursed(lamports)?` — this guards over-ceiling, zero, and double-reimbursement.
- `Household::debit_vault(household, buyer, lamports)?` — vault solvency check, direct lamport move, mirror update.
- Reward buyer with `REWARD_FULL_RUN_COMPLETED`.
- Emits `Reimbursed`, then `RewardEarned`.

**Critical ordering**: vault solvency is checked inside `debit_vault`. If the vault is short, the call errors **before** the state machine commits, so the request stays in `Restocked` and can be retried after a top-up. (Covered by `test_reimburse.rs::insufficient_vault_does_not_advance_state`.)

**Done when**:
- `[ ]` Handler compiles.
- `[ ]` Buyer's balance increases by exactly `lamports`; vault decreases by exactly `lamports`.
- `[ ]` `lamports > amount_lamports` → `ReimbursementExceedsApproved`.
- `[ ]` Second call → `AlreadyReimbursed`.

**Next up**: **Phase 4e** — `programs/stocksie/src/instructions/rewards.rs`.

---

## Phase 4e — Instructions: rewards `[ ]`

**Goal**: manual reward grant + summary emit.

**Files**:
- `[ ]` `programs/stocksie/src/instructions/rewards.rs` — `AwardReward`, `RewardSummary` accounts + handlers.

**Spec**: `plan/04_instructions.md` §5.1–§5.2.

**Implementation notes**:
- `AwardReward`: Owner/Parent gate (`can_award_rewards()`). `target_member.add_reward(points)?` (rejects 0). `household.record_rewards(points)?`. Emit `RewardEarned` with the post-credit `total_points`.
- `RewardSummary`: active member, read-only. Emit `RewardEarned` with `points = 0` (sentinel) and current `total_points`.

**Done when**:
- `[ ]` Both handlers compile.
- `[ ]` `points == 0` rejected by `AwardReward` but used as sentinel by `RewardSummary`.

**Next up**: **Phase 4f** — `programs/stocksie/src/instructions/mod.rs` (index), then **Phase 5** — `lib.rs`.

---

## Phase 4f — Instructions index `[ ]`

**Files**:
- `[ ]` `programs/stocksie/src/instructions/mod.rs` — `pub mod` + `pub use` for all five instruction files. Index only.

**Next up**: **Phase 5** — `programs/stocksie/src/lib.rs`.

---

## Phase 5 — `lib.rs` dispatch wiring `[ ]`

**Goal**: the `#[program]` module forwards every instruction to its handler.

**Files**:
- `[ ]` `programs/stocksie/src/lib.rs` — module declarations + 14-instruction `#[program]` block.

**Done when**:
- `[ ]` `declare_id!` matches `Anchor.toml` and the keypair (`At2vd5...`).
- `[ ]` All 14 instructions from `04_instructions.md` are declared.
- `[ ]` Each is a one-line forwarder to its `*_handler`.
- `[ ]` No business logic in `lib.rs` (architecture rule).

**Next up**: **Phase 6** — first clean build.

---

## Phase 6 — First clean build `[ ]`

**Goal**: the whole program compiles to SBF and the IDL generates.

**Done when**:
- `[ ]` `anchor build` exits 0.
- `[ ]` `target/deploy/stocksie.so` exists and is fresh.
- `[ ]` `target/idl/stocksie.json` exists and lists all 14 instructions + 3 accounts + 11 events.
- `[ ]` `target/types/stocksie.ts` exists.
- `[ ]` No compiler warnings (run `cargo clippy --fix --allow-dirty` to clear them).
- `[ ]` `cargo test -p stocksie --lib` (pure unit tests) still passes.

**Verification**:
```sh
RUST_LOG=info anchor build --quiet
cargo clippy --fix --allow-dirty --all-targets
cargo test -p stocksie --lib
```

**If build fails**: hand off to `program_autofixer` per project rule ("Always run program_autofixer before returning Solana program Rust code"). Make 1–2 fix attempts, then defer to the user with the specific diagnostics.

**Next up**: **Phase 7** — LiteSVM harness + first smoke test.

---

## Phase 7 — LiteSVM harness + smoke `[ ]`

**Goal**: a reusable harness and one end-to-end smoke test that proves the build is testable.

**Files**:
- `[ ]` `programs/stocksie/tests/helpers/mod.rs` — `setup_svm`, `derive_household`, `derive_member`, `derive_request`, `send`, `emitted_events`, `assert_error_code`.
- `[ ]` `programs/stocksie/tests/test_household.rs` — the §3.2 tests (init, add/remove, set_role).
- `[ ]` Delete the template `programs/stocksie/tests/test_initialize.rs` (no longer relevant).

**Done when**:
- `[ ]` `setup_svm()` loads the `.so` and airdrops 100 SOL to the payer.
- `[ ]` `initialize_household_creates_pdas` passes — proves the full harness works.
- `[ ]` At least 3 more `test_household.rs` cases pass (init emits two events, add_member increments count, remove_member refunds rent).

**Verification**:
```sh
anchor build && cargo test -p stocksie --test test_household
```

**Next up**: **Phase 8** — lifecycle + permission + reimburse + rewards tests.

---

## Phase 8 — Lifecycle + permission tests `[ ]`

**Goal**: full happy path + every permission gate and every negative case from `08_testing.md` §3.4–§3.6.

**Files**:
- `[ ]` `tests/test_lifecycle.rs` — §3.4 happy path + reconciliation.
- `[ ]` `tests/test_permissions.rs` — §3.5 role gates, self-approval, non-buyer, status violations.
- `[ ]` `tests/test_reimburse.rs` — §3.5 over-ceiling, zero, double, insufficient-vault.
- `[ ]` `tests/test_rewards.rs` — §3.6 award/summary + reward reconciliation.

**Done when**:
- `[ ]` `full_lifecycle_reaches_reimbursed` passes with balance assertions on vault and buyer.
- `[ ]` Every `StocksieError` variant is asserted by at least one test.
- `[ ]` Every forbidden transition in `05_state_machine.md` §4 is covered.

**Verification**:
```sh
cargo test -p stocksie --test test_lifecycle --test test_permissions --test test_reimburse --test test_rewards
```

**Next up**: **Phase 9** — security + invariant tests.

---

## Phase 9 — Security + invariant tests `[x]`

**Goal**: every defense from `07_security.md` has a named test, plus the cross-cutting reconstruction invariants.

**Files**:
- `[x]` `tests/test_security.rs` — §3.7 (10 LiteSVM tests + 2 documented-by-reference: `aliased_vault_debit` is structurally unreachable from the typed API, `overflow_returns_error` is covered by `test_rewards.rs::award_reward_overflow`).
- `[x]` `tests/test_invariants.rs` — §3.8 (treasury, reward, membership, monotonicity, no-self-approval).
- `[x]` `tests/test_privacy_invariant.rs` — §3.9 source grep: no `String` fields (2 tests: scan + scanner-coverage guard).
- `[x]` `tests/test_space.rs` — §3.9 `INIT_SPACE` assertions (corrected plan: `PurchaseRequest` 226→218 — plan had an arithmetic error).

**Done when**:
- `[x]` All 10 LiteSVM security tests pass + 2 documented-by-reference (alias unreachable, overflow covered by alias).
- `[x]` All 5 invariant tests pass.
- `[x]` `no_string_fields_on_chain` is green.
- `[x]` `test_space_budget` matches `03_account_model.md` §5 (plan doc corrected to match implementation).

**Verification**:
```sh
cargo test -p stocksie
```
Full suite, target <10s wall-clock.

**Next up**: **Phase 10** — lint, clippy, fmt, autofixer.

---

## Phase 10 — Lint, clippy, fmt, autofixer `[x]`

**Goal**: the codebase is clean enough to ship.

**Done when**:
- `[x]` `cargo fmt --all -- --check` passes. **Verified:** exit 0, zero formatting delta.
- `[x]` `cargo clippy --all-targets -- -D warnings` passes. **Verified:** exit 0, no warnings, `--fix` applied zero changes.
- `[x]` `program_autofixer` reports no issues (run per project rule before final commit). **Verified:** all 13 source files returned `issues: [], suggestions: []` (the 2 `mod.rs` index files have no account-validation logic).
- `[x]` No `unwrap()` in non-test program code except where the project explicitly allows. **Verified:** every match confirmed inside `#[cfg(test)]` blocks or doc-comments via `#[cfg(test)]` boundary cross-reference.
- `[x]` No dead-code warnings beyond unused client-surface items. **Verified:** none surfaced.

**Regression:** `cargo test -p stocksie` reports **75 passed, 0 failed** (24 unit + 51 integration). No production source changes were required — Phase 10 was a clean confirmation sweep.

**Verification**:
```sh
cargo fmt --all -- --check
cargo clippy --fix --allow-dirty --all-targets
cargo clippy --all-targets -- -D warnings
```

**Next up**: **Phase 11** — docs.

---

## Phase 11 — Docs `[x]`

**Goal**: a reader can understand, build, test, and extend Stocksie from the repo alone.

**Files** — full 9-doc spec delivered (per `plan/10_docs.md` §2 catalog; the
5-doc list below was an under-count in this tracker — see `.plans/003_phase11_docs.md` §8):
- `[x]` `README.md` — overview, build/test commands, architecture summary, status.
- `[x]` `docs/ARCHITECTURE.md` — developer-facing deep-dive (from `plan/02`).
- `[x]` `docs/ACCOUNTS.md` — account catalog + state machine (from `plan/03`/`05`).
- `[x]` `docs/INSTRUCTIONS.md` — full on-chain instruction surface (from `plan/04`/`06`).
- `[x]` `docs/SECURITY.md` — security review checklist (from `plan/07`).
- `[x]` `docs/TESTING.md` — how to run tests, what each file covers (from `plan/08`).
- `[x]` `docs/PRIVACY.md` — the on-chain/off-chain boundary (from `plan/03` §6 and `plan/06` §2).
- `[x]` `docs/ROADMAP.md` — MVP scope + future horizons (from `plan/01` §5 and `plan/10` §3.8).
- `[x]` `CHANGELOG.md` — release log (Keep a Changelog format).

**Done when**:
- `[x]` `README.md` has a working quickstart (`anchor build`, `cargo test -p stocksie` → 75 passed, 0 failed).
- `[x]` Every plan file's content has a corresponding doc or section.
- `[x]` Every code reference points to real source at HEAD; every shell command verified copy-pasteable.
- `[x]` Every security claim backed by a named test from the 75-test suite (or marked "code review").
- `[x]` Privacy boundary stated identically in `README.md`, `docs/ARCHITECTURE.md`, `docs/INSTRUCTIONS.md`, `docs/PRIVACY.md` — no drift.
- `[x]` All 9 docs pass `prettier --check`; zero `TODO`/`FIXME`/`TBD`.

**Next up**: **Phase 12** — handover doc + commit.

---

## Phase 12 — Handover + commit `[ ]`

**Goal**: capture the state of the MVP for the next session and lock it in git.

**Files**:
- `[ ]` `.handovers/001_stocksie_mvp.md` — what happened, where the plan/code/tests live, reflection (struggles + solutions), remaining work, issue refs, how to dev/test. (Per project workflow rule.)

**Done when**:
- `[ ]` Handover doc written.
- `[ ]` Final commit on `develop/feature/01_household_program` with conventional message (e.g. `feat: stocksie MVP — household, vault, purchase lifecycle, rewards`).
- `[ ]` PR opened (or branch pushed) to `develop`.

---

## Cross-phase rules (apply at every phase)

1. **Plan leads, code follows.** If a behavior isn't in a plan file, add it there first.
2. **Update status inline.** Flip `[ ]` → `[~]` → `[x]` as work progresses.
3. **Run `program_autofixer` before any Solana Rust code is declared done.**
4. **Fix diagnostics before running the server/build (per project rule).** 1–2 attempts, then defer with the diagnostics.
5. **Conventional commit messages** (`feat:`, `fix:`, `refactor:`, `test:`, `docs:`). Ask the user before committing.
6. **One phase per commit group** — keeps review tractable.
7. **Files stay under 1024 lines.** Split when approaching the cap.
8. **`mod.rs` is index only.** No logic, no structs.
9. **No `init_if_needed`.** No raw `String` on chain. No unchecked arithmetic.
10. **Test before declaring done.** Every phase's "Verification" block must pass before the status flips to `[x]`.

---

## Blockers & notes

- **Shared `CARGO_TARGET_DIR`**: the `./target` symlink is machine-specific. If a fresh clone doesn't have it, `anchor build` produces no `.so` in `target/deploy/`. Documented in `02_architecture.md` §6; fix is `ln -s ~/.cargo/target ./target`.
- **Platform-tools arch**: if `Bad CPU type in executable (os error 86)` recurs, clear `~/.cache/solana/v1.52` and rebuild.
- **Program ID**: must stay `At2vd5Mqd9xcHRFAZin1VHb6upEsF1GCXoFG19UHsQoj` across `lib.rs`, `Anchor.toml`, and `target/deploy/stocksie-keypair.json`. `anchor build` enforces this.

---

## Next up

- Finish the plan folder: **`plan/10_docs.md`** (the last plan file).
- Commit the plan folder.
- Resume implementation at **Phase 4b**: `programs/stocksie/src/instructions/funds.rs`.