# Handover 002 — Stocksie MVP complete

**Branch:** `develop/feature/01_household_program`
**Program ID:** `At2vd5Mqd9xcHRFAZin1VHb6upEsF1GCXoFG19UHsQoj` (identical in `lib.rs`, `Anchor.toml`, `target/deploy/stocksie-keypair.json`)
**State:** **MVP complete.** All 12 build phases done. `cargo test -p stocksie` → **75 passed, 0 failed**. `cargo clippy --all-targets -- -D warnings` → exit 0. `cargo fmt --check` → exit 0. 9 documentation files shipped.
**This handover** is committed as part of the Phase 12 final commit. After that commit the branch is ready for PR into `develop`.

---

## 1. What Stocksie is

Stocksie is an Anchor 1.0.2 Solana program that lets a **household** coordinate shared purchases from a **joint treasury vault**, with a four-stage trust lifecycle (request → approve → restock → reimburse), role-based permissions, and an on-chain reputation/rewards ledger. Privacy is enforced architecturally: **only hashes live on chain** (household name, per-unit cost, rejection reason are all `blake3` hashes); plaintext never touches a Solana account.

---

## 2. What was delivered (the 12-phase trail)

| Phase | Surface                    | Outcome                                                                                                     |
| ----- | -------------------------- | ----------------------------------------------------------------------------------------------------------- |
| 0     | Scaffold + toolchain       | Anchor 1.0.2 workspace, `target/` symlinked to shared `~/.cargo/target`, program ID locked                  |
| 1     | Plan folder                | 10 plan files (`plan/01..10_*.md`) + `plan/README.md`                                                       |
| 2     | Foundation                 | `constants.rs`, `error.rs` (24 variants), `events.rs` (12 events), `types.rs` (Role + permissions)          |
| 3     | State layer                | `state/{household,member,purchase_request,mod}.rs` with all transition/credit/debit logic                   |
| 4a–4f | Instructions               | 14 handlers across `household.rs`, `funds.rs`, `purchase.rs`, `reimburse.rs`, `rewards.rs` + index `mod.rs` |
| 5     | `lib.rs` dispatch          | 14 instruction stubs forwarding to `*_handler`                                                              |
| 6     | First clean build          | `anchor build` → `stocksie.so` (387k) + IDL                                                                 |
| 7     | LiteSVM harness            | `tests/helpers/mod.rs` + 4 household smoke tests                                                            |
| 8     | Lifecycle/permission tests | `test_{lifecycle,permissions,reimburse,rewards}.rs`                                                         |
| 9     | Security/invariant tests   | `test_{security,invariants,privacy_invariant,space}.rs`                                                     |
| 10    | Lint/fmt/autofixer         | clean confirmation, zero warnings                                                                           |
| 11    | Docs                       | 9-doc spec (`README`, `CHANGELOG`, 7 in `docs/`)                                                            |
| 12    | Handover + commit          | this file + final commit + tracker reconciliation                                                           |

---

## 3. Architecture

```
programs/stocksie/src/
├── lib.rs                 # declare_id! + 14-instruction #[program] dispatch (no business logic)
├── constants.rs           # PDA seeds, reward constants, lamport bounds
├── error.rs               # 24 StocksieError variants (#[error_code], offset 6000)
├── events.rs              # 12 #[event] structs
├── types.rs               # Role enum + permission methods (decoupled structs/impls)
├── state/
│   ├── mod.rs             # index only
│   ├── household.rs       # Household account + credit_vault/debit_vault + reward bookkeeping
│   ├── member.rs          # Member account + add_reward
│   └── purchase_request.rs# PurchaseRequest account + transition_* state machine
└── instructions/
    ├── mod.rs             # index only
    ├── household.rs       # init/add/remove/set_role
    ├── funds.rs           # deposit/withdraw
    ├── purchase.rs        # create/approve/reject/confirm/close
    ├── reimburse.rs       # reimburse_buyer
    └── rewards.rs         # award_reward/reward_summary
```

**Layering rule (enforced):** constraints live in accounts structs, business rules live in handlers, state mutations go through `state::*` methods (no direct `status = ...` assignments), and `lib.rs` is pure dispatch.

---

## 4. Account model & PDAs

| Account           | `INIT_SPACE` | On-chain size | Rent (lamports) | PDA seeds                                             |
| ----------------- | -----------: | ------------: | --------------: | ----------------------------------------------------- |
| `Household`       |          101 |           109 |      ~1,649,520 | `[b"household", owner]`                               |
| `Member`          |           83 |            91 |      ~1,524,240 | `[b"member", household, wallet]`                      |
| `PurchaseRequest` |          218 |           226 |      ~2,463,840 | `[b"purchase", household, &request_id.to_le_bytes()]` |

All PDAs use the **canonical bump**, stored on the `Household` account and reused — no `find_program_address` in hot paths. Verified by `test_security.rs::canonical_bump_stored`. `test_space.rs::test_space_budget` pins the `INIT_SPACE` numbers above (it caught a plan arithmetic error: `plan/03` had `PurchaseRequest` at 226; the implementation is 218).

---

## 5. Instruction surface (14)

`initialize_household`, `add_member`, `remove_member`, `set_role`, `deposit_funds`, `withdraw_funds`, `create_purchase_request`, `approve_purchase_request`, `reject_purchase_request`, `confirm_restock`, `close_purchase_request`, `reimburse_buyer`, `award_reward`, `reward_summary`.

Note: the five purchase-lifecycle instructions use **canonical long names** (per `plan/06_events.md` §4), not the short names that appeared in an earlier instruction list. Flagged and accepted during Phase 5.

---

## 6. State machine

```
Pending ──approve──▶ Approved ──confirm_restock──▶ Restocked ──reimburse──▶ Reimbursed (terminal)
   │
   └──reject──▶ Rejected (terminal)
```

Every transition goes through `PurchaseRequest::transition_*`. Forbidden transitions are rejected with `InvalidStatusTransition` / `AlreadyTerminal`. `close_purchase_request` is terminal-only and refunds rent to the caller.

---

## 7. Role & permission model

Four roles: **Owner > Parent > Child > Guest**. Verified permission grants (from `types.rs` unit tests):

| Method                                    | Owner | Parent | Child | Guest |
| ----------------------------------------- | :---: | :----: | :---: | :---: |
| `can_manage_members`                      |   ✓   |   ✗    |   ✗   |   ✗   |
| `can_withdraw_funds`                      |   ✓   |   ✗    |   ✗   |   ✗   |
| `can_approve` (purchases/reimburse)       |   ✓   |   ✓    |   ✗   |   ✗   |
| `can_award_rewards`                       |   ✓   |   ✓    |   ✗   |   ✗   |
| `can_transact` (deposit / create request) |   ✓   |   ✓    |   ✓   |   ✗   |

Owner is irremovable and non-promotable (`CannotModifyOwner`). Self-approval of a purchase is forbidden (`SelfApprovalForbidden`).

---

## 8. The 75-test suite

**24 unit** (`src/`, of which 23 hand-written `#[test]` + 1 auto-generated `test_id` from `declare_id!`) **+ 51 integration = 75.**

| File                        |   # | Coverage                                                                                                                            |
| --------------------------- | --: | ----------------------------------------------------------------------------------------------------------------------------------- |
| `test_household.rs`         |   4 | init creates PDAs, init emits 2 events, add increments count, remove refunds rent                                                   |
| `test_invariants.rs`        |   5 | treasury reconciliation, reward reconciliation, membership reconciliation, no-self-approval in event stream, lifecycle monotonicity |
| `test_lifecycle.rs`         |   3 | full happy path to Reimbursed, partial reimbursement residual ceiling, rejection moves no funds                                     |
| `test_permissions.rs`       |  15 | every role gate (child/parent/buyer) + every forbidden transition                                                                   |
| `test_reimburse.rs`         |   7 | over-ceiling, zero, double, insufficient-vault (state not advanced), wrong-status rejects                                           |
| `test_rewards.rs`           |   4 | award, summary sentinel, zero rejected, overflow                                                                                    |
| `test_security.rs`          |  10 | fake account, unsigned, double-init, cross-household isolation (×3), type cosplay, close-then-revive, canonical bump, prefunded PDA |
| `test_privacy_invariant.rs` |   2 | no `String` fields on chain, scanner sees all on-chain structs                                                                      |
| `test_space.rs`             |   1 | `INIT_SPACE` matches account model                                                                                                  |

Every `StocksieError` variant is asserted by ≥1 test, with two **documented** exceptions (see §10).

---

## 9. Where everything lives

- **Design / plan:** `plan/01..10_*.md` + `plan/README.md` (the authoritative spec; code follows plan).
- **Per-phase execution plans:** `.plans/001_phase9_security_invariant_tests.md`, `002_phase10_lint_fmt_sweep.md`, `003_phase11_docs.md`.
- **Program source:** `programs/stocksie/src/`.
- **Tests:** `programs/stocksie/tests/` (harness in `helpers/mod.rs`).
- **User/dev docs:** `README.md`, `CHANGELOG.md`, `docs/{ARCHITECTURE,ACCOUNTS,INSTRUCTIONS,SECURITY,TESTING,PRIVACY,ROADMAP}.md`.
- **Tracker:** `plan/09_build_phases.md` (now fully reconciled — see §13).
- **Prior handover:** `.handovers/001_phase5_6_done_phase7_started.md`.

---

## 10. Known limitations & honest gaps

These are documented, not hidden:

1. **Two missing dedicated tests** (defenses exist; dedicated tests do not — see `docs/SECURITY.md` §11):
   - `aliased_vault_debit_rejected` — pass the same account as both `vault` and `to` into `debit_vault`; assert `HouseholdAccountMismatch`. The guard is at `src/state/household.rs` (alias check).
   - `overflow_returns_error` — a dedicated test for the generic `Overflow` error variant (distinct from the `RewardOverflow` path already covered by `award_reward_overflow`).
2. **Event count reconciled (was 11 vs 12).** `events.rs` defines **12** `#[event]` structs (`HouseholdCreated, MemberAdded, MemberRemoved, RoleChanged, FundsDeposited, FundsWithdrawn, PurchaseCreated, PurchaseApproved, PurchaseRejected, Restocked, Reimbursed, RewardEarned`), confirmed by the generated IDL (`target/idl/stocksie.json` lists all 12). Earlier Phase 11 docs cited **11** in a few places; corrected to **12** in this commit across `README.md`, `docs/ARCHITECTURE.md`, and `docs/ROADMAP.md` (plus `README.md`'s `0–11`→`0–12` phase count). The IDL was already correct at 12.
3. **No `invoke_signed` for vault transfers.** `plan/07_security.md` claimed `invoke_signed` is used for reimbursement; the **actual** MVP uses direct lamport moves (`debit_vault` subtracts from the vault PDA and adds to the recipient). Documented accurately in `docs/SECURITY.md` §7.
4. **PR to `develop` not yet opened.** Branch is committed and ready; opening the PR is the one explicit follow-up (tracker Phase 12 reflects this honestly with `[ ]`).
5. **Off-chain plaintext.** By design, plaintext (names, costs, reasons) lives off chain; only `blake3` hashes are on chain. This is the privacy boundary, stated identically in `README.md`, `docs/ARCHITECTURE.md`, `docs/INSTRUCTIONS.md`, `docs/PRIVACY.md`.

---

## 11. Remaining work / next steps for a new contributor

**Immediate (low-effort, non-blocking):**

1. Open the PR: `develop/feature/01_household_program` → `develop`.
2. Add the two tests in §10.1.
3. Reconcile the event count (§10.2) across `events.rs`, the IDL, and docs.

**Short horizon (post-MVP, see `docs/ROADMAP.md`):** 4. Generate a typed client from the IDL via **Codama** (eliminates hand-maintained serializers). 5. Build a reference frontend (`framework-kit` / wallet-standard). 6. Add a Solana Pay checkout + QR flow for household deposits.

**Mainnet readiness (not MVP scope):** 7. Compute budget + priority fee strategy. 8. Rent reclamation audit on `close` paths. 9. Third-party security review of the vault transfer + role escalation surface.

---

## 12. How to dev & test

```sh
# full test suite (target <10s wall-clock)
cargo test -p stocksie

# a single integration file
cargo test -p stocksie --test test_security

# lint gate (must be exit 0 before commit)
cargo clippy --all-targets -- -D warnings
cargo fmt --check

# rebuild the program (SBF) + regenerate IDL
anchor build
```

- `./target` is a symlink to shared `~/.cargo/target` (machine-specific). On a fresh clone: `ln -s ~/.cargo/target ./target`.
- If `Bad CPU type in executable (os error 86)` recurs, clear `~/.cache/solana/v1.52` and rebuild.
- Use `git --no-pager <log|diff|show>` — the delta pager would block the pty.
- macOS CLI tools on this machine: `eza`, `bat`, `rg`, `fd`, `dust`, `procs`, `btm` (not `ls`/`cat`/`grep`/`find`).

---

## 13. Tracker reconciliation (this phase)

`plan/09_build_phases.md` was **stale**: its at-a-glance map and the Phase 4b–8 detail sections showed `[ ]` even though all of 4b–8 were committed (commits `c3de208`, `213d498`, `3604e52`, `276ba74`, `1174c2b`, `d6bb70b`, `a5ab6d9`). Phase 12 reconciled the tracker to match committed reality: 73 checkbox tokens flipped `[ ]`→`[x]`, plus surgical prose fixes (status legend, the `RESUME HERE` marker, `Current focus`, `Next up` footer, `001`→`002` handover filename, the Phase 11 5-doc→9-doc description, and the honest PR-not-opened line). The only remaining `[ ]` in the tracker is the genuinely-incomplete "PR to develop" item.

---

## 14. Spec deviations to remember

1. **5 purchase instruction names** — used canonical long names (`create_purchase_request` etc.), not the short names in an earlier list.
2. **`UncheckedAccount` over `AccountInfo`** for the reimbursement buyer — Anchor 1.0.2 deprecates raw `AccountInfo`; the field carries a thorough `/// CHECK:` doc.
3. **No `#[index]` attribute** — removed during Phase 2 (Anchor 1.0.2 has no such attribute).
4. **Crate-level `#![allow(clippy::diverging_sub_expression)]`** in `lib.rs` — root cause: Anchor's generated `if false { let _: Ty = panic!(); }` arg-type-check scaffolding emits the lint once per instruction arg. Benign dead code.
5. **Direct lamport moves, not `invoke_signed`** for vault debit (see §10.3).
6. **`INIT_SPACE` for `PurchaseRequest` is 218**, not 226 — the plan doc had an arithmetic error; the implementation + test are authoritative.

---

## 15. Git history (the 15-commit MVP trail)

```
<final> feat: stocksie MVP — household, vault, purchase lifecycle, rewards   (Phase 12)
6860470 docs: Phase 11 — 9-doc spec
ef6c068 chore: Phase 10 lint/fmt/autofixer sweep
8c323b4 test: Phase 9 security + invariant + privacy + space tests
a5ab6d9 test: Phase 8 lifecycle/permission/reimburse/rewards tests
d6bb70b test: LiteSVM harness + household smoke tests (Phase 7)
976da0f style: cargo fmt cleanup of Phase 5+6 source files
1174c2b feat: wire all 14 instruction dispatch stubs + first clean anchor build (Phase 5+6)
276ba74 feat: award_reward + reward_summary (Phase 4e)
3604e52 feat: reimburse_buyer (Phase 4d)
213d498 feat: purchase lifecycle (Phase 4c)
c3de208 feat: deposit_funds + withdraw_funds (Phase 4b)
6a2cd94 fix: make foundation compile
406937e feat: anchor scaffold + program foundation
363705e docs: add implementation plan folder
```

**Next session starts here:** open the PR to `develop`, then pick from §11. The MVP is feature-complete and green; everything beyond is hardening and integration.
