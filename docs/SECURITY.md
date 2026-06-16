# Stocksie — Security

> **Audience:** a security reviewer or auditor. Written so a reviewer can treat
> this doc as a checklist and verify each claim against the code. For the account
> model these defenses protect see [ACCOUNTS.md](ACCOUNTS.md); for the
> instruction surface see [INSTRUCTIONS.md](INSTRUCTIONS.md); for the full test
> matrix see [TESTING.md](TESTING.md).

This is the polished output of the internal security rationale in
[`../plan/07_security.md`](../plan/07_security.md). Where this doc and the plan
disagree, the **code** is the source of truth — and where a plan-cited test name
was renamed or consolidated during implementation, this doc uses the **actual**
test name from the 75-test suite (see [`../plan/003_phase11_docs.md`](../.plans/003_phase11_docs.md) §8 honesty notes).

Every claim below is either backed by a named test in
[`tests/`](../programs/stocksie/tests/) or explicitly labeled **code review**.
The pre-deployment checklist (§10) ticks every box the same way.

---

## 1. Core principle

Assume an attacker controls:

- Every account passed into an instruction.
- Every instruction argument.
- Transaction ordering (within reason).
- CPI call graphs (via composability).

The program must reach a correct, authorized state **regardless** of the inputs
a hostile client supplies. Anchor's typed accounts and constraints handle most of
this automatically; the handler code closes the rest.

---

## 2. Vulnerability matrix

Each Solana attack category maps to Stocksie's concrete defense and the test (or
code-review note) that verifies it.

### 2.1 Missing owner checks

**Risk.** Attacker substitutes a fake account with the right discriminator.

**Defense.** All on-chain accounts are loaded as typed `Account<'info, T>`
(`Account<Household>`, `Account<Member>`, `Account<PurchaseRequest>`). Anchor
rejects accounts whose owner is not the program ID before deserialization. We
never use a raw `AccountInfo` for our own state (the sole `UncheckedAccount` is
the reimbursement `buyer`, which is heavily constrained inline — see §2.9 and
[INSTRUCTIONS.md](INSTRUCTIONS.md) §2.4).

**Verified by:** `fake_account_rejected` in
[`test_security.rs`](../programs/stocksie/tests/test_security.rs).

### 2.2 Missing signer checks

**Risk.** A wallet performs an operation it never authorized.

**Defense.** Every mutating instruction takes a `Signer<'info>` (the `caller` /
`owner` / `buyer`). The `caller_member` PDA is seeded with `caller.key()`, so the
seed only resolves when the signer is the actual caller — a non-signing pubkey
cannot be substituted.

**Verified by:** `unsigned_call_rejected` in
[`test_security.rs`](../programs/stocksie/tests/test_security.rs).

### 2.3 Arbitrary CPI attacks

**Risk.** The program invokes a malicious substitute for an expected CPI target.

**Defense.** The only CPI in the MVP is the system-program `transfer` inside
`Household::credit_vault`. It targets `Program<'info, System>`, so Anchor
enforces the program ID is the system program. No other program is invoked.
Reimbursements and withdrawals are **direct lamport moves**, not CPI.

**Verified by:** **code review.** No `invoke` / `CpiContext::new` with an
untyped `AccountInfo` exists in the source (a `rg 'CpiContext::new'` over
`programs/stocksie/src/` returns exactly one site — the system-program transfer
in [`state/household.rs`](../programs/stocksie/src/state/household.rs)).

### 2.4 Reinitialization attacks

**Risk.** Calling `init` on an already-initialized account overwrites it.

**Defense.** Every account creation uses Anchor's `init` (never `init_if_needed`).
A duplicate `initialize_household`, `add_member`, or `create_purchase_request`
collides on the PDA and fails at the `init` step before the handler runs.
`remove_member` and `close_purchase_request` use `close = caller`, which
reassigns the account to the system program — a revival attempt at the same
address requires re-deriving the PDA, which `init` again rejects unless the
account is genuinely closed.

**Verified by:** `double_init_rejected` and `close_then_revive_rejected` in
[`test_security.rs`](../programs/stocksie/tests/test_security.rs).

### 2.5 PDA sharing vulnerabilities

**Risk.** A single PDA unlocks assets for multiple users.

**Defense.** Every PDA seed includes a user-specific or household-specific
component:

- `Household`: `[HOUSEHOLD_SEED, owner]` — bound to the owner.
- `Member`: `[MEMBER_SEED, household, wallet]` — bound to both.
- `PurchaseRequest`: `[PURCHASE_SEED, household, &request_id.to_le_bytes()]` —
  bound to the household and a monotonic nonce.

No two households share a PDA. No two members share a PDA. No two requests share
a PDA.

**Verified by:** `cross_household_isolation` in
[`test_security.rs`](../programs/stocksie/tests/test_security.rs) — a `Member`
from household A cannot act in household B.

### 2.6 Type cosplay attacks

**Risk.** An account of one type is passed as another.

**Defense.** Anchor's `#[account]` macro attaches an 8-byte discriminator per
type. `Account<'info, Household>` rejects any account whose discriminator does
not match `Household`'s. You cannot pass a `Member` where a `Household` is
expected.

**Verified by:** `type_cosplay_rejected` in
[`test_security.rs`](../programs/stocksie/tests/test_security.rs).

### 2.7 Duplicate mutable accounts

**Risk.** The same account is passed twice; mutations cancel.

**Defense.** `Household::debit_vault` explicitly rejects `vault.key() == to.key()`
(the anti-alias guard) before moving lamports:

```programs/stocksie/src/state/household.rs#L131-135
        // Defensive: never allow the vault and destination to alias.
        // (Security checklist: duplicate mutable accounts can corrupt state.)
        if vault.key() == to.key() {
            return Err(StocksieError::HouseholdAccountMismatch.into());
        }
```

For reimbursement, `buyer` is a separate wallet from the household PDA by
construction (the household is a PDA; the buyer is a user keypair). For
withdrawal, `to` is always `household.owner`, a user keypair.

**Verified by:** **code review** of the alias guard above. (The MVP suite does
not include a dedicated `aliased_vault_debit_rejected` test; the guard is the
defense. Adding such a test is a low-effort follow-up — see §11.)

### 2.8 Revival attacks

**Risk.** A closed account is refunded mid-transaction and re-exploited.

**Defense.** Anchor's `close = caller` zero-fills data, drains lamports, and
reassigns ownership to the system program **before** the instruction returns. A
revival attempt finds a system-owned, discriminatorless account; our `init`
re-initializes every field rather than trusting any stale value.

**Verified by:** `close_then_revive_rejected` in
[`test_security.rs`](../programs/stocksie/tests/test_security.rs).

### 2.9 Data matching vulnerabilities

**Risk.** The signer matches the transaction but not the stored owner/buyer field.

**Defense.**

- `has_one = household` on every `Member` and `PurchaseRequest` constraint
  verifies the back-reference matches the `household` account in the instruction.
- `withdraw_funds` defense-in-depth: `household.owner == owner.key()`.
- `confirm_restock`: `request.buyer == buyer_member.wallet` **and**
  `request.buyer == buyer.key()`.
- `reimburse_buyer`: `buyer_member.wallet == request.buyer` **and**
  `buyer.key() == request.buyer`.

**Verified by:** `cross_household_has_one_rejected` and
`cross_household_account_rejected` in
[`test_security.rs`](../programs/stocksie/tests/test_security.rs).

### 2.10 Bump canonicalization

**Risk.** A non-canonical bump derives an unintended PDA.

**Defense.** Every account stores `bump = ctx.bumps.*` at init (`ctx.bumps.*` is
the canonical bump Anchor derives during `init`). CPI signing reuses the stored
byte; we never re-derive and never trust a caller-supplied bump.

**Verified by:** `canonical_bump_stored` in
[`test_security.rs`](../programs/stocksie/tests/test_security.rs).

### 2.11 Lamport griefing (pre-funded PDA)

**Risk.** An attacker pre-funds a PDA so `init` behaves unexpectedly.

**Defense.** Anchor's `init` allocates and assigns via the system program, which
fails on a non-empty account. A pre-funded PDA at our seeds is therefore
non-initializable. We do not perform manual `create_account` flows that could be
vulnerable to the deficit-calculation variant.

**Verified by:** `prefunded_pda_init_rejected` in
[`test_security.rs`](../programs/stocksie/tests/test_security.rs).

### 2.12 Missing writable / read-only enforcement

**Risk.** A read-only account is mutated, or a writable account is silently
treated as read-only.

**Defense.** Anchor's `Account<'info, T>` requires the account to be writable for
mutation. Read-only references use `Account<'info, T>` without `mut`. The runtime
rejects the transaction if a writable operation targets a read-only account.

**Verified by:** Anchor runtime (automatic).

---

## 3. Program-specific invariants

These go beyond the generic checklist and are specific to Stocksie's domain.

### 3.1 Vault solvency

The vault (household PDA) never goes negative. `debit_vault` checks
`lamports > self.vault_balance` before moving, and `vault_balance` is mirrored to
`account.lamports()` on every mutation. Reimbursement runs the lifecycle guard
_before_ the SOL move, so a failed reimbursement leaves the request in
`Restocked` (retryable) rather than `Reimbursed` (terminal but unpaid).

**Verified by:** `reimburse_insufficient_vault` in
[`test_reimburse.rs`](../programs/stocksie/tests/test_reimburse.rs), and the
cross-cutting `treasury_reconciliation` invariant in
[`test_invariants.rs`](../programs/stocksie/tests/test_invariants.rs) (deposits −
withdrawals − reimbursements == `vault_balance` at any slot).

### 3.2 No double reimbursement

A `PurchaseRequest` can be reimbursed at most once. `transition_reimbursed`
requires `status == Restocked`; after success, `status == Reimbursed` (terminal).
A second call hits the `Status::Reimbursed => AlreadyReimbursed` arm.

**Verified by:** `double_reimburse` in
[`test_reimburse.rs`](../programs/stocksie/tests/test_reimburse.rs).

### 3.3 Reimbursement ceiling

The vault never pays more than the approved ceiling.
`transition_reimbursed(lamports)` rejects `lamports > amount_lamports` with
`ReimbursementExceedsApproved`.

**Verified by:** `reimburse_over_ceiling` in
[`test_reimburse.rs`](../programs/stocksie/tests/test_reimburse.rs). The
under-ceiling happy path (delta stays in the vault) is verified by
`partial_reimbursement_leaves_residual_ceiling` in
[`test_lifecycle.rs`](../programs/stocksie/tests/test_lifecycle.rs).

### 3.4 No self-approval

An approver cannot approve their own spend. `approve_purchase_request` rejects
`request.buyer == caller.key()` with `SelfApprovalForbidden` — this applies even
to the Owner.

**Verified by:** `buyer_cannot_approve_own_request` in
[`test_permissions.rs`](../programs/stocksie/tests/test_permissions.rs), and the
cross-cutting `no_self_approval_in_event_stream` invariant in
[`test_invariants.rs`](../programs/stocksie/tests/test_invariants.rs).

### 3.5 Only the buyer may confirm restock

`confirm_restock` requires `request.buyer == caller.key()`. No other member can
mark someone else's request as restocked.

**Verified by:** `non_buyer_cannot_confirm_restock` in
[`test_permissions.rs`](../programs/stocksie/tests/test_permissions.rs).

### 3.6 The Owner is irremovable and non-promotable

`remove_member` and `set_role` both reject the Owner via `role != Owner`. `add_member`
rejects `role == Owner`. The owner is the household's identity root (in the seed)
and cannot be removed, demoted, or created by any path other than
`initialize_household`.

**Verified by:** `remove_owner_rejected`, `set_role_to_owner_rejected`, and
`add_member_with_owner_role_rejected` in
[`test_permissions.rs`](../programs/stocksie/tests/test_permissions.rs).

### 3.7 Inactive / removed members lose all authority

Every `can_*` check combines `active && role.can_*()`. A removed member's `Member`
PDA is closed (`close = caller` in `remove_member`), so it cannot be derived —
the seed constraint fails before any role predicate is consulted. A deactivated
member fails the explicit `active @ StocksieError::MemberInactive` constraint.

**Verified by:** the `MemberInactive` constraint on every caller/buyer gate,
exercised across the permission and security suites (e.g. the role-gate tests in
[`test_permissions.rs`](../programs/stocksie/tests/test_permissions.rs)). The
unit test `inactive_members_cannot_transact_or_approve_regardless_of_role` in
[`state/member.rs`](../programs/stocksie/src/state/member.rs) pins the predicate.

---

## 4. Arithmetic safety

Every numeric operation on `u64` and `u32` uses checked arithmetic:

- `checked_add`, `checked_sub`, `checked_mul` with
  `ok_or(StocksieError::Overflow)` or `ok_or(StocksieError::RewardOverflow)`.
- No bare `+`, `-`, `*` on integer types.
- The workspace [`Cargo.toml`](../Cargo.toml) sets `overflow-checks = true` in
  the release profile as a defense-in-depth net.

**Verified by:** `award_reward_overflow` in
[`test_rewards.rs`](../programs/stocksie/tests/test_rewards.rs) (the
`RewardOverflow` path), plus the `checked_*` pattern visible at every mutation
site in [`state/`](../programs/stocksie/src/state/). (A dedicated
`overflow_returns_error` test on the generic `Overflow` variant is a follow-up —
see §11.)

---

## 5. Privacy invariant

No instruction argument, account field, or event payload contains raw item
names, quantities, receipts, prices, or any free-form text. Permitted on-chain
data shapes: `Pubkey`, `u64`/`u32`/`u8`, `[u8; 32]` (blake3 digest), small enums
(`Role`, `Status`), `bool`.

**Verified by:** `no_string_fields_on_chain` in
[`test_privacy_invariant.rs`](../programs/stocksie/tests/test_privacy_invariant.rs)
— a source-grep test that asserts no `String` field appears in any `#[account]`
or `#[event]` struct. The companion test `scanner_sees_all_on_chain_structs`
asserts the scanner itself does not silently miss a struct, so the invariant
stays machine-checked as the codebase grows. See [PRIVACY.md](PRIVACY.md) for the
full boundary contract.

---

## 6. Cross-account reference integrity

Every account that belongs to a household carries a `household: Pubkey`
back-reference. Every instruction that loads such an account also loads the
`Household` account and uses `has_one = household`. This prevents a `Member` from
household A authorizing an action in household B, or a `PurchaseRequest` from
household A being reimbursed by household B's vault.

**Verified by:** `cross_household_account_rejected` and
`cross_household_isolation` in
[`test_security.rs`](../programs/stocksie/tests/test_security.rs).

---

## 7. CPI signing safety

The household PDA signs nothing in the MVP via `invoke_signed` — reimbursements
and withdrawals are direct lamport moves out of the program-owned vault PDA. The
sole CPI is the system-program `transfer` in `credit_vault`, which is signed by
the depositor (a real signer), not by the PDA.

When PDA signing is needed in future (e.g. an SPL-token vault), the canonical
pattern is already in place: signer seeds are constructed from the **stored**
canonical bump and the **stored** owner, never from caller input:

```programs/stocksie/src/state/household.rs#L72-82
    pub fn signer_seeds<'a>(&'a self, owner: &'a Pubkey) -> [&'a [u8]; 3] {
        // `std::slice::from_ref` borrows `self.bump` (part of `&'a self`) for
        // lifetime `'a`, producing a one-element `&'a [u8]`. The naive
        // `&[self.bump]` would create a temporary array and return a dangling
        // reference to it (E0515).
        [
            HOUSEHOLD_SEED,
            owner.as_ref(),
            std::slice::from_ref(&self.bump),
        ]
    }
```

**Verified by:** `canonical_bump_stored` (the stored bump is canonical) in
[`test_security.rs`](../programs/stocksie/tests/test_security.rs); the SOL
movement itself is verified end-to-end by `full_lifecycle_reaches_reimbursed` in
[`test_lifecycle.rs`](../programs/stocksie/tests/test_lifecycle.rs).

---

## 8. Account closure safety

`remove_member` and `close_purchase_request` use `close = caller`. Anchor's
`close`:

1. Drains lamports to `caller`.
2. Zero-fills the data.
3. Reassigns ownership to the system program.

This prevents rent leakage (lamports go to the caller), zombie accounts (data is
wiped), and revival attacks (the system-program-owned, zero-filled account cannot
be deserialized back into our types). A clean re-add after close works via a
fresh `init`, because `init` re-initializes every field.

**Verified by:** `close_then_revive_rejected` in
[`test_security.rs`](../programs/stocksie/tests/test_security.rs), and
`remove_member_refunds_rent` in
[`test_household.rs`](../programs/stocksie/tests/test_household.rs).

---

## 9. Agent-assisted development safety

Per the security checklist's agent-safety section, the AI-assisted build
followed these rules throughout:

- **No key material.** The plan and code never request, generate, log, or store
  private keys. All keypairs in tests are ephemeral `Keypair::new()`.
- **Default to safe clusters.** Tests run in LiteSVM (no cluster); deployment
  scripts default to localnet unless explicitly set.
- **Simulate first.** LiteSVM tests exercise the real compiled `.so` in-process,
  surfacing failures before any cluster submit.
- **Validate before deserializing.** Anchor's typed accounts validate owner,
  discriminator, and constraints before the handler runs.
- **Sanitize on-chain data.** Event payloads and account fields are treated as
  untrusted at the client boundary; the client re-derives `household` references
  rather than trusting embedded pubkeys.

---

## 10. Pre-deployment review checklist

Before any deployment beyond localnet, every box below must be checked. Each is
linked to the verifying test (or marked **code review** where no dedicated test
exists yet).

### Account validation

- [x] All program accounts loaded as typed `Account<'info, T>` — `fake_account_rejected`.
- [x] Signer requirements expressed via `Signer<'info>` — `unsigned_call_rejected`.
- [x] Writable requirements expressed via `mut` on the accounts struct — Anchor runtime.
- [x] PDAs derived from canonical seeds + stored canonical bump — `canonical_bump_stored`.
- [x] `has_one = household` on every cross-account reference — `cross_household_has_one_rejected`.
- [x] Duplicate-account aliasing rejected in `debit_vault` — **code review** (guard at `state/household.rs`).
- [x] Pre-funded PDA `init` rejected by Anchor — `prefunded_pda_init_rejected`.

### CPI safety

- [x] Only CPI is `system_program::transfer` via typed `Program<'info, System>` — **code review**.
- [x] No arbitrary program IDs passed to any CPI — **code review**.
- [x] Direct lamport moves use the stored canonical bump (no `invoke_signed` in MVP) — `canonical_bump_stored`.

### Arithmetic

- [x] All `u64`/`u32` math uses `checked_*` — **code review** + `award_reward_overflow`.
- [x] `overflow-checks = true` in the release profile — [`Cargo.toml`](../Cargo.toml).

### State lifecycle

- [x] `init` only (no `init_if_needed`) — `double_init_rejected`.
- [x] `close = caller` for rent reclamation — `remove_member_refunds_rent`.
- [x] Reimbursement is one-shot (`Restocked → Reimbursed` is terminal) — `double_reimburse`.
- [x] Removed members' PDAs cannot be reused without a fresh `init` — `close_then_revive_rejected`.

### Domain invariants

- [x] Vault cannot go negative — `reimburse_insufficient_vault` + `treasury_reconciliation`.
- [x] No double reimbursement — `double_reimburse`.
- [x] No over-ceiling reimbursement — `reimburse_over_ceiling`.
- [x] No self-approval — `buyer_cannot_approve_own_request` + `no_self_approval_in_event_stream`.
- [x] Only the buyer confirms restock — `non_buyer_cannot_confirm_restock`.
- [x] Owner is irremovable and non-promotable — `remove_owner_rejected`, `set_role_to_owner_rejected`, `add_member_with_owner_role_rejected`.
- [x] Inactive members lose all authority — `inactive_members_cannot_transact_or_approve_regardless_of_role` (unit) + the `MemberInactive` constraint exercised across the suite.

### Privacy

- [x] No `String` fields on any account or event — `no_string_fields_on_chain`.
- [x] All human-readable concepts reduced to `[u8; 32]` hashes — `no_string_fields_on_chain`.
- [x] The grep scanner sees every on-chain struct — `scanner_sees_all_on_chain_structs`.

---

## 11. Open security questions (resolved for MVP)

- **Q: Should the vault be a separate PDA from the household?**
  **A: No.** One account, one rent. The household PDA _is_ the vault. Solvency is
  a single `lamports()` read. Splitting them would add an account, a seed, and a
  `has_one` for no security gain.

- **Q: Should reimbursements use `system_program::transfer` or direct lamport moves?**
  **A: Direct moves.** The vault is a program-owned PDA; it cannot be a
  system-program signer. The canonical pattern is a direct lamport move with an
  explicit alias guard — this is what `debit_vault` does.

- **Q: Is `init_if_needed` ever acceptable?**
  **A: No.** The security checklist forbids it due to reinitialization risk.
  Member re-add flows through `close` then fresh `init`.

- **Q: Should we store a `Vec<Pubkey>` roster on the `Household`?**
  **A: No.** A fixed-size `Vec` either caps membership hard or wastes rent.
  Per-wallet `Member` PDAs scale, are independently closable, and the
  `member_count` field gives a cheap cap check without iterating.

- **Q: Should `withdraw_funds` allow an arbitrary destination?**
  **A: No.** The destination is always `household.owner`. Routing treasury to a
  third party in one instruction would defeat the reimbursement flow. Third-party
  payouts go through `reimburse_buyer` against an approved request.

### Known follow-ups (not MVP blockers)

The two **code review** items in §10 are honest gaps in the _test_ coverage, not
in the defense:

1. **`aliased_vault_debit_rejected`** — a dedicated test that passes the same
   account as both `vault` and `to` to `debit_vault` and asserts
   `HouseholdAccountMismatch`. The guard exists; the test does not.
2. **`overflow_returns_error`** — a dedicated test for the generic `Overflow`
   variant (distinct from the `RewardOverflow` path already covered by
   `award_reward_overflow`).

Both are low-effort additions for the next hardening pass; neither weakens the
shipped defenses.
