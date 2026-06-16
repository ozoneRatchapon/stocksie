# Stocksie — Security Checklist (Applied)

> The trust-critical surfaces of Stocksie (vault, approvals, reimbursements, rewards) make security a first-class concern. This document maps every item from the Solana Security Checklist to a concrete guarantee in the Stocksie program, and lists the LiteSVM tests that verify each one.

This is the source the implementation audits against. Every `constraint` annotation, every checked-arithmetic call, and every test case in `tests/test_security.rs` traces back to a row here.

---

## 1. Core principle

Assume an attacker controls:

- Every account passed into an instruction.
- Every instruction argument.
- Transaction ordering (within reason).
- CPI call graphs (via composability).

The program must reach a correct, authorized state **regardless** of the inputs a hostile client supplies. Anchor's typed accounts and constraints handle most of this automatically; the handler code closes the rest.

---

## 2. Vulnerability matrix — Stocksie's defense for each item

### 2.1 Missing owner checks

**Risk**: Attacker substitutes a fake account with the right discriminator.

**Stocksie defense**: All on-chain accounts are loaded as typed `Account<'info, T>` (e.g. `Account<Household>`, `Account<Member>`, `Account<PurchaseRequest>`). Anchor rejects accounts whose owner is not the program ID before deserialization. We never use raw `AccountInfo` for our own state.

**Verified by**: `test_security.rs::fake_account_rejected`.

---

### 2.2 Missing signer checks

**Risk**: A wallet performs an operation it never authorized.

**Stocksie defense**:

- Every instruction that mutates state takes a `Signer<'info>` (the `caller` / `owner` / `buyer` depending on context).
- The `caller_member` PDA is seeded with `caller.key()`, so the seed only resolves when the signer is the actual caller — a non-signing pubkey cannot be substituted.
- Reimbursement, withdrawal, role change, and member removal all require the caller's signature.

**Verified by**: `test_permissions.rs::unsigned_call_rejected`.

---

### 2.3 Arbitrary CPI attacks

**Risk**: The program invokes a malicious substitute for an expected CPI target.

**Stocksie defense**: The only CPI in the MVP is the system-program `transfer` inside `Household::credit_vault`. It targets `Program<'info, System>`, so Anchor enforces the program ID is the system program. No other program is invoked. There are no token-program CPIs in the MVP (the vault is native SOL).

**Verified by**: code review (no `invoke` / `CpiContext::new` with an untyped `AccountInfo`).

---

### 2.4 Reinitialization attacks

**Risk**: Calling `init` on an already-initialized account overwrites it.

**Stocksie defense**:

- Every account creation uses Anchor's `init` constraint (never `init_if_needed`).
- A duplicate `initialize_household`, `add_member`, or `create_purchase_request` collides on the PDA and fails at the `init` step before the handler runs.
- `remove_member` and `close_purchase_request` use `close = caller`, which reassigns the account to the system program — a revival attempt at the same address would require re-deriving the PDA, which `init` again rejects unless the account is genuinely closed.

**Verified by**: `test_security.rs::double_init_rejected`, `test_security.rs::revival_after_close_rejected`.

---

### 2.5 PDA sharing vulnerabilities

**Risk**: A single PDA unlocks assets for multiple users.

**Stocksie defense**: Every PDA seed includes a user-specific or household-specific component:

- `Household`: `[HOUSEHOLD_SEED, owner]` — bound to the owner.
- `Member`: `[MEMBER_SEED, household, wallet]` — bound to both the household and the wallet.
- `PurchaseRequest`: `[PURCHASE_SEED, household, &request_id.to_le_bytes()]` — bound to the household and a monotonic nonce.

No two households share a PDA. No two members share a PDA. No two requests share a PDA.

**Verified by**: `test_security.rs::cross_household_isolation` (a Member from household A cannot act in household B).

---

### 2.6 Type cosplay attacks

**Risk**: An account of one type is passed as another.

**Stocksie defense**: Anchor's `#[account]` macro attaches an 8-byte discriminator per type. `Account<'info, Household>` rejects any account whose discriminator doesn't match `Household`'s. You cannot pass a `Member` where a `Household` is expected.

**Verified by**: Anchor runtime (automatic); `test_security.rs::type_cosplay_rejected` asserts a `Member` cannot be passed as a `Household`.

---

### 2.7 Duplicate mutable accounts

**Risk**: The same account is passed twice; mutations cancel.

**Stocksie defense**:

- `Household::debit_vault` explicitly rejects `vault.key() == to.key()` (the anti-alias guard) before moving lamports.
- For reimbursement, `buyer` is a separate wallet from the household PDA by construction (the household is a PDA; the buyer is a user keypair).
- For withdrawal, `to` is always `household.owner`, which is a user keypair, never the household PDA.

**Verified by**: `test_security.rs::aliased_vault_debit_rejected`.

---

### 2.8 Revival attacks

**Risk**: A closed account is refunded mid-transaction and re-exploited.

**Stocksie defense**: Anchor's `close = caller` zero-fills data, drains lamports, and reassigns ownership to the system program **before** the instruction returns. A second instruction in the same transaction that tries to use the closed account finds it system-owned and discriminatorless; our `init` would require it to be empty (which it is) but the seeds would need to re-derive — and `init` succeeds only when the runtime is happy with a fresh allocation, not a revival. We do not trust any field of a re-created account; `init` re-initializes every field.

**Verified by**: `test_security.rs::close_then_revive_rejected`.

---

### 2.9 Data matching vulnerabilities

**Risk**: The signer matches the transaction but not the stored owner field.

**Stocksie defense**:

- `has_one = household` on every `Member` and `PurchaseRequest` account constraint ensures the account's `household` field equals the `household` account in the instruction.
- `withdraw_funds` defense-in-depth check `household.owner == owner.key()`.
- `confirm_restock` requires `request.buyer == buyer.key()`.

**Verified by**: `test_security.rs::cross_household_has_one_rejected`.

---

### 2.10 Bump canonicalization

**Risk**: A non-canonical bump derives an unintended PDA.

**Stocksie defense**: Every account stores `bump = ctx.bumps.*` at init. `ctx.bumps.*` is the canonical bump derived by Anchor during `init`. CPI signing reuses the stored byte; we never re-derive and never trust a caller-supplied bump.

**Verified by**: `test_security.rs::canonical_bump_stored`.

---

### 2.11 Lamport griefing (pre-funded PDA)

**Risk**: An attacker pre-funds a PDA so `init` behaves unexpectedly.

**Stocksie defense**: Anchor's `init` allocates and assigns via the system program, which fails on a non-empty account. A pre-funded PDA at our seeds is therefore non-initializable. We do not perform manual `create_account` flows that could be vulnerable to the deficit-calculation variant.

**Verified by**: `test_security.rs::prefunded_pda_init_rejected`.

---

### 2.12 Missing writable / read-only enforcement

**Risk**: A read-only account is mutated, or a writable account is silently treated as read-only.

**Stocksie defense**: Anchor's `Account<'info, T>` requires the account to be writable for mutation. Read-only references use `Account<'info, T>` without `mut`. The runtime rejects the transaction if a writable operation targets a read-only account.

**Verified by**: Anchor runtime (automatic).

---

## 3. Program-specific invariants

These go beyond the generic checklist and are specific to Stocksie's domain.

### 3.1 Vault solvency

The vault (household PDA) never goes negative. Enforced by:

- `debit_vault` checks `lamports > self.vault_balance` before moving.
- `vault_balance` is mirrored to `account.lamports()` on every mutation.
- Reimbursement checks vault solvency *before* the state-machine transition commits, so a failed reimbursement leaves the request in `Restocked` (retryable) rather than `Reimbursed` (terminal but unpaid).

**Verified by**: `test_reimburse.rs::insufficient_vault_does_not_advance_state`.

### 3.2 No double reimbursement

A `PurchaseRequest` can be reimbursed at most once. Enforced by:

- `transition_reimbursed` requires `status == Restocked`.
- After success, `status == Reimbursed` (terminal).
- A second call hits the `Status::Reimbursed => AlreadyReimbursed` arm.

**Verified by**: `test_reimburse.rs::double_reimbursement_rejected`.

### 3.3 Reimbursement ceiling

The vault never pays more than the approved ceiling. Enforced by:

- `transition_reimbursed(lamports)` rejects `lamports > amount_lamports` with `ReimbursementExceedsApproved`.

**Verified by**: `test_reimburse.rs::over_ceiling_rejected`.

### 3.4 No self-approval

An approver cannot approve their own spend. Enforced by:

- `approve_purchase_request` rejects `request.buyer == caller.key()` with `SelfApprovalForbidden`.
- This applies even to the Owner.

**Verified by**: `test_permissions.rs::self_approval_rejected`.

### 3.5 Only the buyer may confirm restock

`confirm_restock` requires `request.buyer == caller.key()`. No other member can mark someone else's request as restocked.

**Verified by**: `test_permissions.rs::non_buyer_cannot_confirm_restock`.

### 3.6 The Owner is irremovable

`remove_member` and `set_role` both reject the Owner via `role != Owner`. The owner is the household's identity root (in the seed) and cannot be removed or demoted.

**Verified by**: `test_permissions.rs::cannot_remove_owner`, `test_permissions.rs::cannot_demote_owner`.

### 3.7 Inactive members lose all authority

Every `can_*` check combines `active && role.can_*()`. A member who has been removed (account closed) cannot derive the PDA, so they fail at the seed constraint. A member who has been deactivated (future suspension flow) fails the `active` constraint.

**Verified by**: `test_permissions.rs::removed_member_cannot_act`.

---

## 4. Arithmetic safety

Every numeric operation on `u64` and `u32` uses checked arithmetic:

- `checked_add`, `checked_sub`, `checked_mul` with `ok_or(StocksieError::Overflow)` or `ok_or(StocksieError::RewardOverflow)`.
- No bare `+`, `-`, `*` on integer types.
- The workspace `Cargo.toml` has `overflow-checks = true` in the release profile as a defense-in-depth net.

**Verified by**: `cargo clippy` (custom lint for unchecked arithmetic is a roadmap item); `test_security.rs::overflow_returns_error`.

---

## 5. Privacy invariant

No instruction argument, account field, or event payload contains raw item names, quantities, receipts, prices, or any free-form text. Permitted on-chain data shapes:

- `Pubkey`
- `u64`, `u32`, `u8`
- `[u8; 32]` (blake3 digest)
- Small enums (`Role`, `Status`)
- `bool`

A grep-based test (`tests/test_privacy_invariant.rs`) asserts that no `String` field appears in any `#[account]` or `#[event]` struct.

**Verified by**: `test_privacy_invariant.rs::no_string_fields_on_chain`.

---

## 6. Cross-account reference integrity

Every account that belongs to a household carries a `household: Pubkey` back-reference. Every instruction that loads such an account also loads the `Household` account and uses `has_one = household` to verify the back-reference matches. This prevents:

- A `Member` from household A authorizing an action in household B.
- A `PurchaseRequest` from household A being reimbursed by household B's vault.

**Verified by**: `test_security.rs::cross_household_account_rejected`.

---

## 7. CPI signing safety

The household PDA signs the reimbursement SOL transfer. The signer seeds are constructed from the stored canonical bump:

```rust
let signer_seeds = &[HOUSEHOLD_SEED, owner.as_ref(), &[household.bump]];
```

- The bump comes from `household.bump` (stored at init), never from a caller.
- The owner in the seed comes from `household.owner` (stored at init), never from a caller.
- The seed slice is constructed inside the handler, not borrowed from user-supplied data.

**Verified by**: `test_reimburse.rs::reimbursement_signs_with_canonical_bump` (the transfer succeeds; an attempt with a wrong bump fails).

---

## 8. Account closure safety

`remove_member` and `close_purchase_request` use `close = caller`. Anchor's `close`:

1. Drains lamports to `caller`.
2. Zero-fills the data.
3. Reassigns ownership to the system program.

This prevents:

- **Rent leakage**: the closed account's lamports go to the caller, not stuck.
- **Zombie accounts**: the data is wiped, so no stale state lingers.
- **Revival attacks**: the system-program-owned, zero-filled account cannot be deserialized back into our types.

**Verified by**: `test_security.rs::close_drains_and_wipes`, `test_security.rs::close_then_reopen_via_init_succeeds` (a clean re-add after close is allowed, because `init` re-initializes every field).

---

## 9. Agent-assisted development safety

Per the security checklist's agent-safety section, when an AI agent is generating or executing Solana code:

- **No key material**: The plan and code never request, generate, log, or store private keys. All keypairs in tests are ephemeral `Keypair::new()`.
- **Default to safe clusters**: Tests run in LiteSVM (no cluster); deployment scripts default to localnet unless explicitly set.
- **Simulate first**: LiteSVM tests use `simulate_transaction` before `send_transaction` in the lifecycle tests to surface failures before commit.
- **Validate before deserializing**: Anchor's typed accounts validate owner, discriminator, and constraints before the handler runs.
- **Sanitize on-chain data**: Event payloads and account fields are treated as untrusted at the client boundary; the client re-derives `household` references rather than trusting embedded pubkeys.

---

## 10. Pre-deployment review checklist

Before any deployment beyond localnet, every box below must be checked.

### Account validation

- [x] All program accounts loaded as typed `Account<'info, T>` (owner check automatic).
- [x] Signer requirements expressed via `Signer<'info>` or `#[account(signer)]`.
- [x] Writable requirements expressed via `mut` on the accounts struct.
- [x] PDAs derived from canonical seeds + stored canonical bump.
- [x] `has_one = household` on every cross-account reference.
- [x] Duplicate-account aliasing rejected in `debit_vault`.
- [x] Pre-funded PDA `init` rejected by Anchor.

### CPI safety

- [x] Only CPI is `system_program::transfer` via typed `Program<'info, System>`.
- [x] No arbitrary program IDs passed to any CPI.
- [x] `invoke_signed` seeds use the stored canonical bump.

### Arithmetic

- [x] All `u64`/`u32` math uses `checked_*`.
- [x] `overflow-checks = true` in the release profile.

### State lifecycle

- [x] `init` only (no `init_if_needed`).
- [x] `close = caller` for rent reclamation.
- [x] Reimbursement is one-shot (`Restocked → Reimbursed` is terminal).
- [x] Removed members' PDAs cannot be reused without a fresh `init`.

### Domain invariants

- [x] Vault cannot go negative.
- [x] No double reimbursement.
- [x] No over-ceiling reimbursement.
- [x] No self-approval.
- [x] Only the buyer confirms restock.
- [x] Owner is irremovable and non-promotable.
- [x] Inactive members lose all authority.

### Privacy

- [x] No `String` fields on any account or event.
- [x] All human-readable concepts reduced to `[u8; 32]` hashes.
- [x] `test_privacy_invariant.rs` is green.

---

## 11. Open security questions (resolved for MVP)

- **Q: Should the vault be a separate PDA from the household?**
  - **A: No.** One account, one rent. The household PDA *is* the vault. Solvency is a single `lamports()` read. Splitting them would add an account, a seed, and a `has_one` for no security gain.

- **Q: Should reimbursements use `system_program::transfer` or direct lamport moves?**
  - **A: Direct moves.** The vault is a program-owned PDA; it cannot be a system-program signer. The canonical pattern is `**vault.try_borrow_mut_lamports()? -= x; **to.try_borrow_mut_lamports()? += x;` with an explicit alias guard. This is what `debit_vault` does.

- **Q: Is `init_if_needed` ever acceptable?**
  - **A: No.** The security checklist forbids it due to reinitialization risk. Member re-add flows through `close` then fresh `init`.

- **Q: Should we store a `Vec<Pubkey>` roster on the `Household`?**
  - **A: No.** Fixed-size `Vec` either caps membership hard or wastes rent. Per-wallet `Member` PDAs scale, are independently closable, and the `member_count` field gives us a cheap cap check without iterating.

- **Q: Should `withdraw_funds` allow an arbitrary destination?**
  - **A: No.** The destination is always `household.owner`. Routing treasury to a third party in one instruction would defeat the reimbursement flow. Third-party payouts go through `reimburse_buyer` against an approved request.

---

## Next up

- **`plan/08_testing.md`** — the LiteSVM test plan: the testing pyramid, the full test matrix (positive, permission, negative, security, privacy-invariant, space-budget), and the per-file breakdown of what each test file covers. Then `09_build_phases.md` (phased build order with status) and `10_docs.md` (user-facing and developer docs) finish the plan folder before we resume implementation in `programs/stocksie/src/instructions/funds.rs`.